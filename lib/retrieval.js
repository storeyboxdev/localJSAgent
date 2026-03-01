import { supabaseAdmin } from "./supabase.js";
import { generateEmbedding } from "./embeddings.js";
import { keywordSearch } from "./keyword-search.js";
import { rerankChunks } from "./reranker.js";

const SEARCH_MODE = process.env.SEARCH_MODE || "hybrid";
const RERANK_ENABLED = process.env.RERANK_ENABLED === "true";

// Fixed user ID for this single-user personal assistant (no auth layer)
export const PERSONAL_USER_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Vector search via pgvector cosine similarity.
 */
async function vectorSearch(embedding, userId, { limit, threshold, filterDocumentIds }) {
  const rpcParams = {
    query_embedding: JSON.stringify(embedding),
    match_user_id: userId,
    match_count: limit,
    match_threshold: threshold,
  };

  if (filterDocumentIds) {
    rpcParams.filter_document_ids = filterDocumentIds;
  }

  const { data, error } = await supabaseAdmin.rpc("match_document_chunks", rpcParams);

  if (error) {
    console.error("Vector search error:", error);
    return [];
  }

  return data || [];
}

/**
 * Reciprocal Rank Fusion — merge multiple ranked lists into one.
 * score(d) = sum(1 / (k + rank_i)) where rank_i is 1-based position.
 */
export function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = new Map();
  const chunkById = new Map();

  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const chunk = list[i];
      const id = chunk.id;
      const rrfScore = 1 / (k + i + 1);
      scores.set(id, (scores.get(id) || 0) + rrfScore);
      if (!chunkById.has(id)) {
        chunkById.set(id, chunk);
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...chunkById.get(id), rrf_score: score }));
}

/**
 * Search document chunks using vector, keyword, or hybrid mode.
 * Uses the personal user ID — no auth required.
 */
export async function searchDocuments(query, { limit = 5, threshold = 0.5, metadata_filter, document_id } = {}) {
  const userId = PERSONAL_USER_ID;
  let filterDocumentIds = null;

  if (document_id) {
    filterDocumentIds = [document_id];
  } else if (metadata_filter && Object.keys(metadata_filter).length > 0) {
    try {
      let docQuery = supabaseAdmin
        .from("documents")
        .select("id")
        .eq("user_id", userId)
        .eq("status", "completed")
        .not("metadata", "is", null);

      if (metadata_filter.topic) {
        docQuery = docQuery.ilike("metadata->>topic", `%${metadata_filter.topic}%`);
      }
      if (metadata_filter.document_type) {
        docQuery = docQuery.eq("metadata->>document_type", metadata_filter.document_type);
      }
      if (metadata_filter.agent_id) {
        docQuery = docQuery.eq("metadata->>agent_id", metadata_filter.agent_id);
      }

      const { data: matchingDocs, error: filterError } = await docQuery;

      if (filterError) {
        console.error("Metadata filter error:", filterError);
      } else if (matchingDocs && matchingDocs.length === 0) {
        console.warn("Metadata filter matched 0 documents, falling back to unfiltered search");
      } else if (matchingDocs) {
        filterDocumentIds = matchingDocs.map((d) => d.id);
      }
    } catch (err) {
      console.error("Metadata filter error:", err);
    }
  }

  const fetchLimit = RERANK_ENABLED ? limit * 3 : limit;
  let results;

  if (SEARCH_MODE === "keyword") {
    results = await keywordSearch(query, userId, { limit: fetchLimit, filterDocumentIds });
  } else if (SEARCH_MODE === "vector") {
    const embedding = await generateEmbedding(query);
    results = await vectorSearch(embedding, userId, { limit: fetchLimit, threshold, filterDocumentIds });
  } else {
    // hybrid mode (default)
    const embedding = await generateEmbedding(query);
    const [vectorResults, keywordResults] = await Promise.all([
      vectorSearch(embedding, userId, { limit: fetchLimit, threshold, filterDocumentIds }),
      keywordSearch(query, userId, { limit: fetchLimit, filterDocumentIds }),
    ]);
    results = reciprocalRankFusion([vectorResults, keywordResults]).slice(0, fetchLimit);
  }

  if (RERANK_ENABLED && results.length > 0) {
    results = await rerankChunks(query, results, limit);
    results.forEach((r) => { r.similarity = r.rerank_score; });
  } else {
    results = results.slice(0, limit);
  }

  return results;
}
