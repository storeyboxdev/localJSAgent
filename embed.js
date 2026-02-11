// embed.js - Standalone vector embedding & search CLI using LM Studio

import "dotenv/config";
import { LMStudioClient } from "@lmstudio/sdk";
import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, extname, relative } from "node:path";

// --- Configuration ---

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL;
const VECTOR_STORE_PATH = resolve("vectors.json");
const DEFAULT_EXTENSIONS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".json", ".txt", ".md", ".css", ".html",
]);
const CHUNK_SIZE = 1000;   // characters per chunk
const CHUNK_OVERLAP = 200; // overlap between consecutive chunks
const TOP_K = 5;
const BATCH_SIZE = 10;     // chunks per embedding API call

// Lazy-connect to LM Studio embedding model (only when needed for index/search)
let embModel;
async function getEmbeddingModel() {
  if (!embModel) {
    const lms = new LMStudioClient();
    embModel = await lms.embedding.model(EMBEDDING_MODEL);
    const info = await embModel.getModelInfo();
    console.log(`Embedding model: ${info.path}`);
  }
  return embModel;
}

// --- Chunking ---

function chunkText(text, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (text.length <= chunkSize) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let currentChunk = "";
  let chunkStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] + "\n";

    if (currentChunk.length + line.length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trimEnd());

      // Walk backward to build overlap
      let overlapText = "";
      for (let j = i - 1; j >= chunkStartLine; j--) {
        const candidate = lines[j] + "\n" + overlapText;
        if (candidate.length > overlap) break;
        overlapText = candidate;
      }
      currentChunk = overlapText;
      chunkStartLine = i;
    }

    currentChunk += line;
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trimEnd());
  }

  return chunks;
}

// --- Embedding ---

async function embedTexts(texts) {
  const model = await getEmbeddingModel();
  const results = [];
  for (const text of texts) {
    const result = await model.embed(text);
    results.push(Array.from(result.embedding));
  }
  return results;
}

// --- Vector Store I/O ---

function createEmptyStore() {
  return {
    version: 1,
    model: EMBEDDING_MODEL,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

async function loadStore() {
  try {
    const data = await readFile(VECTOR_STORE_PATH, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return createEmptyStore();
    throw err;
  }
}

async function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  await writeFile(VECTOR_STORE_PATH, JSON.stringify(store, null, 2));
}

// --- Similarity ---

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Search ---

async function search(query, { topK = TOP_K, type } = {}) {
  const store = await loadStore();
  if (store.entries.length === 0) return [];

  const [queryEmbedding] = await embedTexts([query]);

  let candidates = store.entries;
  if (type) {
    candidates = candidates.filter((e) => e.metadata.type === type);
  }

  const scored = candidates.map((entry) => ({
    id: entry.id,
    text: entry.text,
    score: cosineSimilarity(queryEmbedding, entry.embedding),
    metadata: entry.metadata,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// --- File Walking ---

async function walkDirectory(dirPath, extensions = DEFAULT_EXTENSIONS) {
  const results = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" || entry.name === ".git" ||
        entry.name === "dist" || entry.name.startsWith(".")
      ) {
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
    return { filesIndexed: 0, chunksCreated: 0 };
  }

  console.log(`Found ${files.length} files to index...`);
  const store = await loadStore();

  // Remove existing entries from this directory (supports re-indexing)
  const dirPrefix = relative(process.cwd(), absoluteDir).replace(/\\/g, "/");
  store.entries = store.entries.filter(
    (e) => !e.metadata.source.startsWith(dirPrefix)
  );

  let totalChunks = 0;
  let pendingChunks = [];

  for (const filePath of files) {
    const relPath = relative(process.cwd(), filePath).replace(/\\/g, "/");
    console.log(`  Reading: ${relPath}`);

    const content = await readFile(filePath, "utf-8");
    if (!content.trim()) continue;

    const chunks = chunkText(content);

    for (let i = 0; i < chunks.length; i++) {
      pendingChunks.push({
        text: chunks[i],
        id: `file::${relPath}::${i}`,
        metadata: {
          source: relPath,
          chunkIndex: i,
          type: "file",
          indexedAt: new Date().toISOString(),
        },
      });
    }

    // Flush batch when it reaches BATCH_SIZE
    while (pendingChunks.length >= BATCH_SIZE) {
      const batch = pendingChunks.splice(0, BATCH_SIZE);
      const embeddings = await embedTexts(batch.map((c) => c.text));
      for (let j = 0; j < batch.length; j++) {
        store.entries.push({ ...batch[j], embedding: embeddings[j] });
      }
      totalChunks += batch.length;
      process.stdout.write(`  Embedded ${totalChunks} chunks...\r`);
    }
  }

  // Flush remaining
  if (pendingChunks.length > 0) {
    const embeddings = await embedTexts(pendingChunks.map((c) => c.text));
    for (let j = 0; j < pendingChunks.length; j++) {
      store.entries.push({ ...pendingChunks[j], embedding: embeddings[j] });
    }
    totalChunks += pendingChunks.length;
  }

  await saveStore(store);
  console.log(`\nIndexed ${files.length} files, ${totalChunks} chunks total.`);
  return { filesIndexed: files.length, chunksCreated: totalChunks };
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
      const results = await search(query);
      if (results.length === 0) {
        console.log("No results found. Have you indexed any files?");
      } else {
        console.log(`\nTop ${results.length} results for: "${query}"\n`);
        for (const r of results) {
          console.log(
            `--- ${r.metadata.source} [chunk ${r.metadata.chunkIndex}] ` +
            `(score: ${r.score.toFixed(4)}) ---`
          );
          const preview = r.text.length > 300 ? r.text.slice(0, 300) + "..." : r.text;
          console.log(preview);
          console.log();
        }
      }
      break;
    }

    case "stats": {
      const store = await loadStore();
      const fileEntries = store.entries.filter((e) => e.metadata.type === "file");
      const convEntries = store.entries.filter((e) => e.metadata.type === "conversation");
      const sources = new Set(fileEntries.map((e) => e.metadata.source));
      console.log(`Vector store: ${store.entries.length} total entries`);
      console.log(`  Files: ${fileEntries.length} chunks from ${sources.size} files`);
      console.log(`  Conversations: ${convEntries.length} chunks`);
      console.log(`  Model: ${store.model}`);
      console.log(`  Last updated: ${store.updatedAt}`);
      break;
    }

    case "clear": {
      await saveStore(createEmptyStore());
      console.log("Vector store cleared.");
      break;
    }

    default:
      console.log("Usage:");
      console.log("  node embed.js index <directory>   Index files in a directory");
      console.log("  node embed.js search <query>      Search for similar content");
      console.log("  node embed.js stats               Show vector store statistics");
      console.log("  node embed.js clear               Reset the vector store");
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
