import { tool, streamText } from "ai";
import { getTracer } from "@lmnr-ai/lmnr";
import { z } from "zod";

const MAX_TOOL_ROUNDS = 3;
const CONTEXT_BUDGET_RATIO = 0.5; // Sub-agent gets 50% of context window

const RESEARCH_SYSTEM_PROMPT = `You are a focused research assistant. Your job is to answer a single research question thoroughly and concisely.

Process:
1. Search the personal knowledge base first (ragSearch) for relevant personal context or notes.
2. Use webSearch for current or general information if needed.
3. Synthesize findings into a clear, factual, sourced answer.

Guidelines:
- Aim for 200-400 words unless more is clearly needed.
- Always cite your sources (e.g., "From personal notes:", "From web search:").
- Do not ask clarifying questions. Research and respond directly.`;

/**
 * Run an isolated research sub-agent using Vercel AI SDK streamText tool loop.
 * Uses the same loaded model in an isolated message context.
 *
 * @param {object} opts
 * @param {string} opts.query - The research question or task
 * @param {object} opts.model - Vercel AI SDK language model
 * @param {number} opts.contextLength - Full context window size
 * @param {Function} opts.searchDocumentsFn - RAG search function from lib/retrieval.js
 * @param {object} opts.mcpClient - MCP client for web search (from @ai-sdk/mcp)
 * @returns {Promise<string>} Compact result string
 */
export async function runResearchAgent({ query, model, contextLength, searchDocumentsFn, mcpClient, isThinkingModel = false }) {
  const budget = Math.floor(contextLength * CONTEXT_BUDGET_RATIO);
  console.log(`[researchAgent] starting — budget: ${budget} tokens, query: "${query.slice(0, 80)}..."`);

  const ragSearch = tool({
    description:
      "Search the personal knowledge base (indexed documents and notes) using semantic hybrid search. " +
      "Use this first before searching the web.",
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      topK: z.number().optional().default(5).describe("Number of results to return"),
    }),
    execute: async ({ query: q, topK = 5 }) => {
      console.log(`[researchAgent:ragSearch] query: "${q}"`);
      try {
        const results = await searchDocumentsFn(q, { limit: topK });
        if (!results.length) return "No relevant documents found.";
        return results
          .map((r, i) => {
            const source = r.document?.filename ?? r.metadata?.source ?? "unknown";
            const score = (r.similarity ?? r.rrf_score ?? 0).toFixed(3);
            return `[${i + 1}] ${source} (score: ${score})\n${r.content}`;
          })
          .join("\n\n---\n\n");
      } catch (err) {
        console.error("[researchAgent:ragSearch] error:", err);
        return `RAG search failed: ${err.message}`;
      }
    },
  });

  const webSearch = tool({
    description: "Search the web for current or general information. Use after checking the local knowledge base.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
    }),
    execute: async ({ query: q }) => {
      console.log(`[researchAgent:webSearch] query: "${q}"`);
      try {
        const result = await mcpClient.callTool({
          name: "tavily_search",
          args: { query: q },
        });
        const rawText = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        let data;
        try { data = JSON.parse(rawText); } catch { return rawText; }
        const parts = [];
        if (data.answer) parts.push(`Answer: ${data.answer}`);
        if (data.results?.length > 0) {
          parts.push("Search results:");
          for (const r of data.results.slice(0, 5)) {
            parts.push(`\n[${r.title}](${r.url})`);
            if (r.content) parts.push(r.content);
          }
        }
        return parts.length > 0 ? parts.join("\n") : rawText;
      } catch (err) {
        console.error("[researchAgent:webSearch] error:", err);
        return `Web search failed: ${err.message}`;
      }
    },
  });

  const subMessages = [{ role: "user", content: query }];
  let result = "";
  let toolRound = 0;

  try {
    while (true) {
      const stream = streamText({
        model,
        system: isThinkingModel ? `/no_think\n${RESEARCH_SYSTEM_PROMPT}` : RESEARCH_SYSTEM_PROMPT,
        messages: subMessages,
        tools: { ragSearch, webSearch },
        experimental_telemetry: { isEnabled: true, tracer: getTracer() },
      });

      let currentText = "";
      const toolCalls = [];

      for await (const chunk of stream.fullStream) {
        if (chunk.type === "text-delta") {
          currentText += chunk.text;
        } else if (chunk.type === "tool-call") {
          toolCalls.push(chunk);
          console.log(`[researchAgent:tool-call] ${chunk.toolName}`);
        }
      }

      // Strip think tags and store last substantive assistant response
      const clean = currentText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (clean) result = clean;

      const response = await stream.response;
      subMessages.push(...response.messages);

      if (toolCalls.length === 0) break;
      if (++toolRound >= MAX_TOOL_ROUNDS) break;
    }
  } catch (err) {
    console.error("[researchAgent] error:", err);
    return `Research agent error: ${err.message}`;
  }

  console.log(`[researchAgent] done — result length: ${result.length} chars`);
  return result || "Research agent returned no results.";
}
