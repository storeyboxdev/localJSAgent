// server.js - Express API for chat agent with SSE streaming

import "dotenv/config";
import { readFileSync } from "node:fs";
import express from "express";
import cors from "cors";
import { LMStudioClient } from "@lmstudio/sdk";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMCPClient } from "@ai-sdk/mcp";
import { streamText, generateText } from "ai";
import { tools, calendar, activeCalendar } from "./tools/index.js";
import { createWebSearch } from "./tools/webSearch.js";
import { createRagSearch } from "./tools/ragSearch.js";
import { searchDocuments } from "./lib/retrieval.js";
import { createDelegateResearchTool } from "./agents/index.js";
import { createCalendarMonitor } from "./monitors/calendarMonitor.js";
import { createMonitorRegistry } from "./monitors/index.js";

const SYSTEM_PROMPT = readFileSync("system-prompt.txt", "utf-8")
  .replace("{{DATE}}", new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }));

const provider = createOpenAICompatible({
  name: "lmstudio",
  apiKey: "lm-studio",
  baseURL: process.env.LMSTUDIO_BASE_URL,
});

// Fetch loaded model info from LM Studio HTTP API
const apiBase = process.env.LMSTUDIO_BASE_URL.replace(/\/v1\/?$/, "");
const modelsRes = await fetch(`${apiBase}/api/v0/models`);
const modelsData = await modelsRes.json();
const loadedLlm = modelsData.data.find(
  (m) => m.state === "loaded" && (m.type === "llm" || m.type === "vlm")
);
if (!loadedLlm) throw new Error("No loaded LLM found in LM Studio. Load a model first.");
let contextLength = loadedLlm.loaded_context_length;
const model = provider(loadedLlm.id);
console.log(`Model: ${loadedLlm.id} (context: ${contextLength})`);

// LMStudio SDK — for countTokens() (requires WebSocket SDK API enabled in LM Studio)
const wsBase = process.env.LMSTUDIO_BASE_URL.replace(/^http/, "ws").replace(/\/v1\/?$/, "");
let lmmodel = null;
try {
  const lmsClient = new LMStudioClient({ baseUrl: wsBase, logger: "error" });
  lmmodel = await lmsClient.llm.model();
  contextLength = await lmmodel.getContextLength();
  console.log("[lmstudio-sdk] connected — token counting enabled");
} catch (e) {
  console.warn("[lmstudio-sdk] SDK unavailable, token counting disabled:", e.message.split("\n")[0]);
  console.warn("[lmstudio-sdk] Enable 'SDK API' in LM Studio → Local Server settings");
}

const app = express();
app.use(cors());
app.use(express.json());

let allTools;
let registry;

// Tag filter: suppresses content inside <think>, <arg_key>, <arg_value> tags
const SUPPRESS_TAGS = ["think", "arg_key", "arg_value"];
const MAX_OPEN_LEN = Math.max(...SUPPRESS_TAGS.map((t) => `<${t}>`.length));
const MAX_CLOSE_LEN = Math.max(...SUPPRESS_TAGS.map((t) => `</${t}>`.length));

const AUTO_COMPACT_THRESHOLD = 0.80;

function serializeMessages(systemPrompt, messages) {
  const parts = [];
  if (systemPrompt) parts.push(`system: ${systemPrompt}`);
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      parts.push(`${msg.role}: ${msg.content}`);
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .map((p) => {
          if (p.type === "text") return p.text;
          if (p.type === "tool-call")
            return `[tool-call: ${p.toolName}(${JSON.stringify(p.args)})]`;
          if (p.type === "tool-result")
            return `[tool-result: ${JSON.stringify(p.result)}]`;
          return JSON.stringify(p);
        })
        .join(" ");
      parts.push(`${msg.role}: ${text}`);
    }
  }
  return parts.join("\n");
}

function processBuffer(buffer, insideTag, emit) {
  while (buffer.length > 0) {
    if (insideTag) {
      const endTag = `</${insideTag}>`;
      const endIdx = buffer.indexOf(endTag);
      if (endIdx !== -1) {
        insideTag = null;
        buffer = buffer.slice(endIdx + endTag.length);
      } else {
        buffer =
          buffer.length > MAX_CLOSE_LEN - 1
            ? buffer.slice(-(MAX_CLOSE_LEN - 1))
            : buffer;
        break;
      }
    } else {
      let nearestIdx = Infinity;
      let nearestTag = null;
      for (const tag of SUPPRESS_TAGS) {
        const idx = buffer.indexOf(`<${tag}>`);
        if (idx !== -1 && idx < nearestIdx) {
          nearestIdx = idx;
          nearestTag = tag;
        }
      }
      if (nearestTag !== null) {
        emit(buffer.slice(0, nearestIdx));
        insideTag = nearestTag;
        buffer = buffer.slice(nearestIdx + `<${nearestTag}>`.length);
      } else {
        if (buffer.length > MAX_OPEN_LEN - 1) {
          emit(buffer.slice(0, -(MAX_OPEN_LEN - 1)));
          buffer = buffer.slice(-(MAX_OPEN_LEN - 1));
        }
        break;
      }
    }
  }
  return { buffer, insideTag };
}

app.get("/api/context-info", (req, res) => {
  res.json({ contextLength });
});

app.get("/api/monitors", async (req, res) => {
  if (!registry) return res.status(503).json({ error: "Not ready" });
  const calMonitor = registry.get("calendar");
  const upcoming = calMonitor ? await calMonitor.getUpcoming() : [];
  res.json({ monitors: registry.status(), upcoming });
});

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const chatMessages = [...messages];

  try {
    // Tool execution loop (capped to prevent runaway)
    const MAX_TOOL_ROUNDS = 5;
    let toolRound = 0;
    while (true) {
      let insideTag = null;
      let buffer = "";
      const toolCalls = [];

      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages: chatMessages,
        tools: allTools,
      });

      for await (const chunk of result.fullStream) {
        if (chunk.type === "tool-call-streaming-start") {
          console.log(
            `[tool-call-start] id=${chunk.toolCallId} name=${chunk.toolName}`,
          );
        } else if (chunk.type === "tool-call-delta") {
          console.log(
            `[tool-call-delta] argsTextDelta=${JSON.stringify(chunk.argsTextDelta)}`,
          );
        } else if (chunk.type === "text-delta") {
          buffer += chunk.text;
          const state = processBuffer(buffer, insideTag, (text) => {
            if (text) send("text", { text });
          });
          buffer = state.buffer;
          insideTag = state.insideTag;
        } else if (chunk.type === "tool-call") {
          toolCalls.push(chunk);
          console.log(
            `[tool-call] FULL CHUNK:`,
            JSON.stringify(chunk, null, 2),
          );
          // Discard buffer on tool call — it likely contains leaked arg tags
          buffer = "";
          insideTag = null;
          send("tool-call", { toolName: chunk.toolName });
        } else if (chunk.type === "tool-result") {
          console.log(`[tool-result] keys:`, Object.keys(chunk));
          const raw = JSON.stringify(chunk);
          console.log(`[tool-result] preview:`, raw.slice(0, 500));
        } else if (chunk.type === "error") {
          console.error("[stream-error]", chunk.error);
        }
      }

      // Flush remaining buffer
      if (!insideTag && buffer.length > 0) {
        send("text", { text: buffer });
      }

      const response = await result.response;
      chatMessages.push(...response.messages);

      if (toolCalls.length === 0) break;
      if (++toolRound >= MAX_TOOL_ROUNDS) {
        send("text", { text: "\n[max tool rounds reached]" });
        break;
      }
    }

    let tokenCount = null;
    if (lmmodel) {
      try {
        const serialized = serializeMessages(SYSTEM_PROMPT, chatMessages);
        tokenCount = await lmmodel.countTokens(serialized);
        console.log(`[countTokens] ${tokenCount} / ${contextLength}`);
      } catch (e) {
        console.warn("[countTokens] failed:", e.message);
      }
    }
    const shouldCompact = tokenCount != null && tokenCount / contextLength > AUTO_COMPACT_THRESHOLD;

    send("done", { messages: chatMessages, tokenCount, contextLength, shouldCompact });
  } catch (err) {
    send("error", { error: err.message });
  }

  res.end();
});

app.post("/api/compact", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  const KEEP_RECENT = 6; // Keep last 6 messages (~3 exchanges)

  if (messages.length <= KEEP_RECENT) {
    const serialized = serializeMessages(SYSTEM_PROMPT, messages);
    const tokenCount = Math.round(serialized.length / 3.5);
    return res.json({ messages, tokenCount, contextLength, compacted: false });
  }

  const olderMessages = messages.slice(0, messages.length - KEEP_RECENT);
  const recentMessages = messages.slice(messages.length - KEEP_RECENT);

  const toSummarize = serializeMessages(null, olderMessages);
  const summaryPrompt = [
    {
      role: "user",
      content:
        "Provide a concise summary of the following conversation. " +
        "Preserve key facts, decisions, user preferences, and important context " +
        "needed to continue the conversation naturally. " +
        "Be thorough but brief.\n\n---\n" +
        toSummarize +
        "\n---",
    },
  ];

  try {
    const result = streamText({
      model,
      system: "You are a precise summarizer. Output only the summary, nothing else.",
      messages: summaryPrompt,
    });

    let summaryText = "";
    for await (const chunk of result.textStream) {
      summaryText += chunk;
    }

    const compactedMessages = [
      {
        role: "user",
        content: `[Previous Conversation Summary]\n${summaryText}`,
      },
      {
        role: "assistant",
        content: "I have the conversation context from the summary. Let's continue.",
      },
      ...recentMessages,
    ];

    const serialized = serializeMessages(SYSTEM_PROMPT, compactedMessages);
    const tokenCount = Math.round(serialized.length / 3.5);

    res.json({
      messages: compactedMessages,
      tokenCount,
      contextLength,
      compacted: true,
      originalMessageCount: messages.length,
      newMessageCount: compactedMessages.length,
    });
  } catch (err) {
    console.error("[compact] error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  console.log("Connecting to Tavily MCP server...");
  const mcpClient = await createMCPClient({
    transport: {
      type: "http",
      url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`,
    },
  });
  const mcpTools = await mcpClient.tools();
  console.log("MCP tool names:", Object.keys(mcpTools));

  const webSearch = createWebSearch(mcpClient);

  // RAG search tool (Supabase-backed hybrid vector+keyword search)
  const ragSearch = createRagSearch(searchDocuments);

  // Research sub-agent delegation tool (uses streamText internally)
  const delegateResearch = createDelegateResearchTool({
    model,
    contextLength,
    searchDocumentsFn: searchDocuments,
    mcpClient,
  });

  allTools = { ...tools, webSearch, ragSearch, delegateResearch };

  // Start background monitors
  const calMonitor = createCalendarMonitor({ calendar, calendarId: activeCalendar });
  calMonitor.onEvent((event) => {
    console.log(`[monitor] calendar event: "${event.summary}" at ${event.start}`);
    // Future: broadcast via SSE push to connected clients or trigger agent action
  });
  registry = createMonitorRegistry();
  registry.register("calendar", calMonitor);
  registry.startAll();

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
  });
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[server] shutting down...");
  registry?.stopAll();
  process.exit(0);
});

start();
