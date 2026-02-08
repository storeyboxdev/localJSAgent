import { tool } from "ai";
import { z } from "zod";

// Factory: takes the MCP client so we can call Tavily internally
export function createWebSearch(mcpClient) {
  return tool({
    description:
      "Search the web for current information. Don not use for date or time. Use this for any question about recent events, news, scores, standings, weather, etc.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
    }),
    execute: async ({ query }) => {
      console.log(`[webSearch] executing with query: "${query}"`);
      try {
        const result = await mcpClient.callTool({
          name: "tavily_search",
          args: { query },
        });

        // Extract the raw text from the MCP result
        const rawText = result.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n");

        // Try to parse as JSON and format nicely for the model
        let data;
        try {
          data = JSON.parse(rawText);
        } catch {
          // Not JSON — return raw text as-is
          console.log(
            `[webSearch] returning raw text (${rawText.length} chars)`,
          );
          return rawText;
        }

        const parts = [];
        if (data.answer) {
          parts.push(`Answer: ${data.answer}`);
        }
        if (data.results && data.results.length > 0) {
          parts.push("Search results:");
          for (const r of data.results.slice(0, 5)) {
            parts.push(`\n[${r.title}](${r.url})`);
            if (r.content) {
              parts.push(r.content);
            }
          }
        }

        const formatted = parts.length > 0 ? parts.join("\n") : rawText;
        console.log(`[webSearch] formatted length: ${formatted.length} chars`);
        return formatted;
      } catch (err) {
        console.error(`[webSearch] ERROR:`, err);
        return `Search failed: ${err.message}`;
      }
    },
  });
}
