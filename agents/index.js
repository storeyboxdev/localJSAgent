import { tool } from "ai";
import { z } from "zod";
import { runResearchAgent } from "./researchAgent.js";

/**
 * Factory — creates a delegateResearch tool for the main Vercel AI SDK chat agent.
 * The tool hands off the task to the streamText-based research sub-agent
 * and returns its compact result to the main conversation.
 *
 * @param {object} opts
 * @param {object} opts.model - Vercel AI SDK language model
 * @param {number} opts.contextLength - Full context window size
 * @param {Function} opts.searchDocumentsFn - RAG search function from lib/retrieval.js
 * @param {object} opts.mcpClient - MCP client (for webSearch inside sub-agent)
 * @returns {import("ai").Tool}
 */
export function createDelegateResearchTool({ model, contextLength, searchDocumentsFn, mcpClient }) {
  return tool({
    description:
      "Delegate a research task to a specialized sub-agent that searches the personal knowledge base " +
      "and the web, then synthesizes findings. Use this when the question requires document lookup " +
      "or web research and a thorough, cited answer is needed.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The specific research question or task. Be precise — phrase it as a clear, self-contained question."
        ),
    }),
    execute: async ({ query }) => {
      console.log(`[delegateResearch] launching sub-agent for: "${query.slice(0, 80)}"`);
      try {
        const result = await runResearchAgent({
          query,
          model,
          contextLength,
          searchDocumentsFn,
          mcpClient,
        });
        return `Research result:\n\n${result}`;
      } catch (err) {
        console.error("[delegateResearch] sub-agent error:", err);
        return `Research agent failed: ${err.message}`;
      }
    },
  });
}
