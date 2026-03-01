// embed.js - Document indexing CLI for the personal knowledge base (Supabase-backed)

import "dotenv/config";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, extname, relative } from "node:path";
import { supabaseAdmin } from "./lib/supabase.js";
import { chunkText } from "./lib/chunking.js";
import { generateEmbeddings } from "./lib/embeddings.js";
import { searchDocuments, PERSONAL_USER_ID } from "./lib/retrieval.js";

const DEFAULT_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".json", ".txt", ".md", ".css", ".html",
]);
const BATCH_SIZE = 10;

// --- File Walking ---

async function walkDirectory(dirPath, extensions = DEFAULT_EXTENSIONS) {
  const results = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", "build"].includes(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const sub = await walkDirectory(fullPath, extensions);
      results.push(...sub);
    } else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }

  return results;
}

// --- Indexing ---

async function indexDirectory(dirPath) {
  const absoluteDir = resolve(dirPath);
  const files = await walkDirectory(absoluteDir);

  if (files.length === 0) {
    console.log(`No indexable files found in: ${absoluteDir}`);
    return;
  }

  console.log(`Found ${files.length} files to index...`);

  // Remove existing documents for this directory prefix (re-indexing support)
  const dirPrefix = relative(process.cwd(), absoluteDir).replace(/\\/g, "/");
  const { error: deleteError } = await supabaseAdmin
    .from("documents")
    .delete()
    .eq("user_id", PERSONAL_USER_ID)
    .like("filename", `${dirPrefix}/%`);

  if (deleteError) {
    console.error("Warning: failed to clean up existing documents:", deleteError.message);
  }

  let totalChunks = 0;
  let filesIndexed = 0;

  for (const filePath of files) {
    const relPath = relative(process.cwd(), filePath).replace(/\\/g, "/");
    console.log(`  Indexing: ${relPath}`);

    let content;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      console.warn(`  Skipping ${relPath}: ${err.message}`);
      continue;
    }
    if (!content.trim()) continue;

    const fileStat = await stat(filePath);
    const ext = extname(filePath).toLowerCase();
    const docId = crypto.randomUUID();

    const { error: docError } = await supabaseAdmin.from("documents").insert({
      id: docId,
      user_id: PERSONAL_USER_ID,
      filename: relPath,
      file_type: ext || "text/plain",
      file_size: fileStat.size,
      storage_path: filePath,
      status: "processing",
      chunk_count: 0,
    });

    if (docError) {
      console.error(`  Failed to create document record for ${relPath}:`, docError.message);
      continue;
    }

    const chunks = chunkText(content);
    if (chunks.length === 0) {
      await supabaseAdmin.from("documents").update({ status: "completed" }).eq("id", docId);
      continue;
    }

    try {
      const allEmbeddings = [];
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await generateEmbeddings(batch.map((c) => c.content));
        allEmbeddings.push(...embeddings);
        process.stdout.write(`    Embedded ${allEmbeddings.length}/${chunks.length} chunks...\r`);
      }
      process.stdout.write("\n");

      const chunkRows = chunks.map((chunk, i) => ({
        document_id: docId,
        user_id: PERSONAL_USER_ID,
        content: chunk.content,
        chunk_index: chunk.chunkIndex,
        embedding: JSON.stringify(allEmbeddings[i]),
      }));

      const { error: chunkError } = await supabaseAdmin.from("document_chunks").insert(chunkRows);
      if (chunkError) throw new Error(`Chunk insert failed: ${chunkError.message}`);

      await supabaseAdmin
        .from("documents")
        .update({ status: "completed", chunk_count: chunks.length })
        .eq("id", docId);

      totalChunks += chunks.length;
      filesIndexed++;
    } catch (err) {
      console.error(`  Error indexing ${relPath}:`, err.message);
      await supabaseAdmin
        .from("documents")
        .update({ status: "error", error_message: err.message })
        .eq("id", docId);
    }
  }

  console.log(`\nDone: ${filesIndexed}/${files.length} files indexed, ${totalChunks} total chunks.`);
}

// --- CLI ---

async function main() {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "index": {
      const dir = args[0];
      if (!dir) {
        console.error("Usage: node embed.js index <directory>");
        process.exit(1);
      }
      await indexDirectory(dir);
      break;
    }

    case "search": {
      const query = args.join(" ");
      if (!query) {
        console.error("Usage: node embed.js search <query>");
        process.exit(1);
      }
      const results = await searchDocuments(query, { limit: 5 });
      if (results.length === 0) {
        console.log("No results found. Have you indexed any files?");
      } else {
        console.log(`\nTop ${results.length} results for: "${query}"\n`);
        for (const r of results) {
          const filename = r.document?.filename ?? r.metadata?.source ?? "unknown";
          const score = (r.similarity ?? r.rrf_score ?? 0).toFixed(4);
          console.log(`--- ${filename} [chunk ${r.chunk_index}] (score: ${score}) ---`);
          const preview = r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content;
          console.log(preview);
          console.log();
        }
      }
      break;
    }

    case "stats": {
      const { data: docs, error: docError } = await supabaseAdmin
        .from("documents")
        .select("filename, status, chunk_count")
        .eq("user_id", PERSONAL_USER_ID)
        .order("filename");

      if (docError) {
        console.error("Error fetching stats:", docError.message);
        process.exit(1);
      }

      const completed = docs.filter((d) => d.status === "completed");
      const totalChunks = completed.reduce((sum, d) => sum + (d.chunk_count || 0), 0);

      console.log(`Knowledge base stats:`);
      console.log(`  Documents: ${docs.length} total (${completed.length} indexed)`);
      console.log(`  Chunks: ${totalChunks}`);
      if (docs.length > 0) {
        console.log(`\n  Files:`);
        for (const d of docs) {
          console.log(`    [${d.status}] ${d.filename} (${d.chunk_count ?? 0} chunks)`);
        }
      }
      break;
    }

    case "clear": {
      const { error } = await supabaseAdmin
        .from("documents")
        .delete()
        .eq("user_id", PERSONAL_USER_ID);

      if (error) {
        console.error("Error clearing knowledge base:", error.message);
        process.exit(1);
      }
      console.log("Knowledge base cleared.");
      break;
    }

    default:
      console.log("Usage:");
      console.log("  node embed.js index <directory>   Index files from a directory into Supabase");
      console.log("  node embed.js search <query>      Test hybrid search");
      console.log("  node embed.js stats               Show indexed documents and chunk counts");
      console.log("  node embed.js clear               Delete all indexed documents");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
