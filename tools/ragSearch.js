import { tool } from "ai";
import { z } from "zod";

/**
 * Factory function — inject searchDocuments from lib/retrieval.js at wiring time.
 * Follows the same factory pattern as tools/webSearch.js.
 */
export function createRagSearch(searchDocumentsFn, { agentId } = {}) {
  return tool({
    description:
      "Search the personal knowledge base (indexed documents and notes) using semantic + keyword hybrid search. " +
      "Use this before webSearch for questions about personal context, past notes, or indexed documents. " +
      "Returns relevant excerpts with source file citations.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      topK: z.number().optional().default(5).describe("Number of results to return (default 5)"),
    }),
    execute: async ({ query, topK = 5 }) => {
      console.log(`[ragSearch] query: "${query}", topK: ${topK}${agentId ? `, agentId: ${agentId}` : ""}`);
      try {
        const searchOptions = { limit: topK };
        if (agentId) searchOptions.metadata_filter = { agent_id: agentId };
        const results = await searchDocumentsFn(query, searchOptions);
        if (!results.length) {
          return "No relevant documents found in the local knowledge base.";
        }
        return results
          .map((r, i) => {
            const source = r.document?.filename ?? r.metadata?.source ?? "unknown";
            const score = (r.similarity ?? r.rrf_score ?? 0).toFixed(3);
            return `[${i + 1}] ${source} (score: ${score})\n${r.content}`;
          })
          .join("\n\n---\n\n");
      } catch (err) {
        console.error("[ragSearch] ERROR:", err);
        return `RAG search failed: ${err.message}`;
      }
    },
  });
}
