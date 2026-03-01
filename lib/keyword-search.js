import { supabaseAdmin } from "./supabase.js";

/**
 * Search document chunks by keyword (full-text search via tsvector).
 * Returns matched chunks with rank scores.
 */
export async function keywordSearch(query, userId, { limit = 10, filterDocumentIds = null } = {}) {
  const rpcParams = {
    query_text: query,
    match_user_id: userId,
    match_count: limit,
  };

  if (filterDocumentIds) {
    rpcParams.filter_document_ids = filterDocumentIds;
  }

  const { data, error } = await supabaseAdmin.rpc("keyword_search_chunks", rpcParams);

  if (error) {
    console.error("Keyword search error:", error);
    return [];
  }

  return data || [];
}
