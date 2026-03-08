import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamText, tool } from "ai";
import { z } from "zod";
import { getTracer } from "@lmnr-ai/lmnr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, "..", ".news-monitor-state.json");
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SCHEDULE_WINDOW_MS = 5 * 60 * 1000;        // fire within 5-min window

// State shape: { [agentId]: { lastRunDate: "YYYY-MM-DD" } }
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); }
  catch { return {}; }
}
function saveState(state) {
  try { writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("[newsMonitor] state save error:", e.message); }
}

export function shouldRunNow(variables, lastRunDate) {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (lastRunDate === todayStr) return false;

  const schedule = (variables.SCHEDULE ?? "daily").toLowerCase().trim();
  const day = now.getDay();
  if (schedule === "weekdays" && (day === 0 || day === 6)) return false;
  if (schedule === "weekends" && day >= 1 && day <= 5) return false;

  const [hStr, mStr] = (variables.TIME ?? "08:00").split(":");
  const scheduledH = parseInt(hStr, 10);
  const scheduledM = parseInt(mStr, 10);
  if (isNaN(scheduledH) || isNaN(scheduledM)) return false;

  const scheduled = new Date(now);
  scheduled.setHours(scheduledH, scheduledM, 0, 0);
  const diff = now.getTime() - scheduled.getTime();
  return diff >= 0 && diff < SCHEDULE_WINDOW_MS;
}

async function runBriefing(agentId, { model, mcpClient, getAgentFn, saveAgentMessagesFn, noThinkFn, handlers, state }) {
  console.log(`[newsMonitor] running briefing for agent ${agentId}`);
  const instance = getAgentFn(agentId);
  if (!instance) { console.warn(`[newsMonitor] agent ${agentId} not found`); return; }

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const webSearch = tool({
    description: "Search the web for current news and information.",
    inputSchema: z.object({ query: z.string().describe("The search query") }),
    execute: async ({ query: q }) => {
      console.log(`[newsMonitor:webSearch] query: "${q}"`);
      try {
        const result = await mcpClient.callTool({ name: "tavily_search", args: { query: q } });
        const rawText = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
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
        console.error("[newsMonitor:webSearch] error:", err);
        return `Web search failed: ${err.message}`;
      }
    },
  });

  const MAX_TOOL_ROUNDS = 12;
  const briefingMessages = [
    { role: "user", content: `Run your scheduled news briefing for today, ${today}.` },
  ];
  let briefingText = "";
  let toolRound = 0;

  try {
    while (true) {
      if (toolRound === MAX_TOOL_ROUNDS - 1) {
        briefingMessages.push({
          role: "user",
          content: "[You have reached your final tool call. After this, write your complete briefing without calling any more tools.]",
        });
      }

      const stream = streamText({
        model,
        system: noThinkFn(instance.resolvedSystemPrompt ?? "You are a news briefing assistant."),
        messages: briefingMessages,
        tools: { webSearch },
        experimental_telemetry: { isEnabled: true, tracer: getTracer() },
      });

      let currentText = "";
      const toolCalls = [];

      for await (const chunk of stream.fullStream) {
        if (chunk.type === "text-delta") {
          currentText += chunk.text;
        } else if (chunk.type === "tool-call") {
          toolCalls.push(chunk);
          console.log(`[newsMonitor:tool-call] ${chunk.toolName}("${chunk.args?.query}")`);
        }
      }

      const clean = currentText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (clean) briefingText = clean;

      const response = await stream.response;
      briefingMessages.push(...response.messages);

      if (toolCalls.length === 0) break;
      if (++toolRound >= MAX_TOOL_ROUNDS) break;
    }
  } catch (err) {
    console.error(`[newsMonitor] loop error for ${agentId}:`, err.message);
    return;
  }

  if (!briefingText) { console.warn(`[newsMonitor] empty briefing for ${agentId}, skipping`); return; }

  // Inject as a user-marker + assistant pair (maintains conversation structure)
  const updatedMessages = [
    ...(instance.messages ?? []),
    { role: "user", content: `[Scheduled briefing — ${today}]` },
    { role: "assistant", content: briefingText },
  ];
  try {
    saveAgentMessagesFn(agentId, updatedMessages, null);
  } catch (err) {
    console.error(`[newsMonitor] save error for ${agentId}:`, err.message);
    return;
  }

  state[agentId] = { lastRunDate: new Date().toISOString().slice(0, 10) };
  saveState(state);
  console.log(`[newsMonitor] briefing saved for "${instance.name}" (${briefingText.length} chars)`);

  for (const handler of handlers) {
    try { handler({ agentId, agentName: instance.name, agentIcon: instance.icon ?? "📰", summary: `${topic} briefing ready` }); }
    catch (e) { console.error("[newsMonitor] handler error:", e); }
  }
}

export function createNewsMonitor({ model, mcpClient, listAgentsFn, getAgentFn, saveAgentMessagesFn, noThinkFn, NEWS_ARCHETYPE_ID }) {
  let timer = null;
  const handlers = [];
  const state = loadState();

  async function poll() {
    const newsAgents = listAgentsFn().filter((a) => a.archetypeId === NEWS_ARCHETYPE_ID);
    for (const meta of newsAgents) {
      const lastRunDate = state[meta.id]?.lastRunDate ?? null;
      const instance = getAgentFn(meta.id);
      if (!instance) continue;
      if (shouldRunNow(instance.variables ?? {}, lastRunDate)) {
        runBriefing(meta.id, { model, mcpClient, getAgentFn, saveAgentMessagesFn, noThinkFn, handlers, state })
          .catch((err) => console.error("[newsMonitor] unexpected error:", err));
      }
    }
  }

  return {
    onBriefing(handler) { handlers.push(handler); },

    start(intervalMs = DEFAULT_POLL_INTERVAL_MS) {
      if (timer) return;
      console.log(`[newsMonitor] starting — poll every ${intervalMs / 1000}s`);
      poll();
      timer = setInterval(poll, intervalMs);
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null; console.log("[newsMonitor] stopped"); }
    },

    async runNow(agentId) {
      await runBriefing(agentId, { model, mcpClient, getAgentFn, saveAgentMessagesFn, noThinkFn, handlers, state });
    },
  };
}
