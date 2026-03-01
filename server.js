// server.js - Express API for chat agent with SSE streaming

import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import multer from "multer";
import { LMStudioClient } from "@lmstudio/sdk";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMCPClient } from "@ai-sdk/mcp";
import { streamText } from "ai";
import { tools, calendar, activeCalendar } from "./tools/index.js";
import { createWebSearch } from "./tools/webSearch.js";
import { createRagSearch } from "./tools/ragSearch.js";
import { searchDocuments } from "./lib/retrieval.js";
import { createDelegateResearchTool } from "./agents/index.js";
import { createCalendarMonitor } from "./monitors/calendarMonitor.js";
import { createMonitorRegistry } from "./monitors/index.js";
import {
  loadArchetypes,
  getArchetype,
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  saveAgentMessages,
  deleteAgent,
} from "./lib/agentStore.js";
import { chunkText } from "./lib/chunking.js";
import { generateEmbeddings } from "./lib/embeddings.js";
import { supabaseAdmin as supabase } from "./lib/supabase.js";
import { parseFile } from "./lib/parsing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// Multer — memory storage for document uploads (no temp files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB per file
});

let allTools;
let registry;

// Tag filter: suppresses content inside <think>, <arg_key>, <arg_value> tags
const SUPPRESS_TAGS = ["think", "arg_key", "arg_value"];
const MAX_OPEN_LEN = Math.max(...SUPPRESS_TAGS.map((t) => `<${t}>`.length));
const MAX_CLOSE_LEN = Math.max(...SUPPRESS_TAGS.map((t) => `</${t}>`.length));

const AUTO_COMPACT_THRESHOLD = 0.80;

// Personal user ID for Supabase vector store (single-user setup)
const PERSONAL_USER_ID = "00000000-0000-0000-0000-000000000001";

// System prompt for the agent-builder conversation
const CONVERSE_SYSTEM_PROMPT = `You are an AI agent configuration assistant. Your job is to design a custom AI assistant for the user.

Ask focused questions (one at a time, maximum 2 follow-ups) to understand:
1. What the assistant should do / its main purpose
2. Whether it should search the web or the user's knowledge base
3. Any specific persona, tone, or constraints

Available tools you can assign: dateTime, readFile, writeFile, deleteFile, listFiles, changeDirectory, currentDirectory, listCalendars, setActiveCalendar, listEvents, addEvent, editEvent, deleteEvent, webSearch, ragSearch, delegateResearch.

When you have enough information (after 1-3 exchanges), end your message with a JSON block in this exact format — do not omit it:

<agent-config>
{
  "name": "Short Name",
  "icon": "🤖",
  "systemPrompt": "You are ... [100-200 words]",
  "tools": ["dateTime", "webSearch"]
}
</agent-config>

Do not produce the <agent-config> block until you have enough information to make good choices.
Keep all messages concise and friendly.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Build the tool subset for a given archetype tool list. If agentInstance is provided
 *  and the subset includes ragSearch, a scoped ragSearch is created for that agent. */
function buildToolSubset(toolNames, agentInstance) {
  if (!toolNames || toolNames.length === 0) return allTools;
  const subset = Object.fromEntries(
    toolNames.filter((name) => allTools[name]).map((name) => [name, allTools[name]])
  );
  if (agentInstance && subset.ragSearch) {
    subset.ragSearch = createRagSearch(searchDocuments, { agentId: agentInstance.id });
  }
  return subset;
}

// ---------------------------------------------------------------------------
// Static endpoints
// ---------------------------------------------------------------------------

app.get("/api/context-info", (req, res) => {
  res.json({ contextLength });
});

app.get("/api/monitors", async (req, res) => {
  if (!registry) return res.status(503).json({ error: "Not ready" });
  const calMonitor = registry.get("calendar");
  const upcoming = calMonitor ? await calMonitor.getUpcoming() : [];
  res.json({ monitors: registry.status(), upcoming });
});

// ---------------------------------------------------------------------------
// Archetype endpoints
// ---------------------------------------------------------------------------

app.get("/api/archetypes", (req, res) => {
  res.json(loadArchetypes());
});

// ---------------------------------------------------------------------------
// Agent instance endpoints
// ---------------------------------------------------------------------------

app.get("/api/agents", (req, res) => {
  res.json(listAgents());
});

app.post("/api/agents", (req, res) => {
  const { archetypeId, name, variables, systemPrompt, tools: agentTools, icon } = req.body;
  if (!archetypeId && !systemPrompt) {
    return res.status(400).json({ error: "archetypeId or systemPrompt required" });
  }
  try {
    const instance = createAgent({ archetypeId, name, variables, systemPrompt, tools: agentTools, icon });
    const { messages: _m, ...lightweight } = instance;
    res.status(201).json(lightweight);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/agents/:id", (req, res) => {
  const instance = getAgent(req.params.id);
  if (!instance) return res.status(404).json({ error: "Agent not found" });
  res.json(instance);
});

app.patch("/api/agents/:id", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  try {
    const updated = updateAgent(req.params.id, { name });
    const { messages: _m, ...lightweight } = updated;
    res.json(lightweight);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/agents/:id", (req, res) => {
  try {
    deleteAgent(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Agent builder conversation endpoint (SSE streaming)
// ---------------------------------------------------------------------------

app.post("/api/agents/converse", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = streamText({
      model,
      system: CONVERSE_SYSTEM_PROMPT,
      messages,
    });

    let buffer = "";
    let insideTag = null;
    for await (const chunk of result.textStream) {
      buffer += chunk;
      const state = processBuffer(buffer, insideTag, (text) => {
        if (text) send("text", { text });
      });
      buffer = state.buffer;
      insideTag = state.insideTag;
    }
    if (!insideTag && buffer.length > 0) send("text", { text: buffer });

    send("done", {});
  } catch (err) {
    send("error", { error: err.message });
  }

  res.end();
});

// ---------------------------------------------------------------------------
// Chat endpoint
// ---------------------------------------------------------------------------

app.post("/api/chat", async (req, res) => {
  const { messages, agentId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }
  if (!allTools) {
    return res.status(503).json({ error: "Server still initializing, please wait" });
  }

  // Load agent instance if provided
  let agentInstance = null;
  if (agentId) {
    agentInstance = getAgent(agentId);
    if (!agentInstance) return res.status(404).json({ error: "Agent not found" });
  }

  const systemPrompt = agentInstance ? agentInstance.resolvedSystemPrompt : SYSTEM_PROMPT;
  const activeTools = agentInstance ? buildToolSubset(agentInstance.tools, agentInstance) : allTools;

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
        system: systemPrompt,
        messages: chatMessages,
        tools: activeTools,
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
        const serialized = serializeMessages(systemPrompt, chatMessages);
        tokenCount = await lmmodel.countTokens(serialized);
        console.log(`[countTokens] ${tokenCount} / ${contextLength}`);
      } catch (e) {
        console.warn("[countTokens] failed:", e.message);
      }
    }
    const shouldCompact = tokenCount != null && tokenCount / contextLength > AUTO_COMPACT_THRESHOLD;

    // Auto-save agent messages to disk
    if (agentId) {
      try {
        saveAgentMessages(agentId, chatMessages, tokenCount);
      } catch (e) {
        console.warn("[agentStore] save failed:", e.message);
      }
    }

    send("done", { messages: chatMessages, tokenCount, contextLength, shouldCompact, agentId });
  } catch (err) {
    send("error", { error: err.message });
  }

  res.end();
});

// ---------------------------------------------------------------------------
// Compact endpoint
// ---------------------------------------------------------------------------

app.post("/api/compact", async (req, res) => {
  const { messages, agentId } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages array required" });
  }

  const agentInstance = agentId ? getAgent(agentId) : null;
  const systemPrompt = agentInstance ? agentInstance.resolvedSystemPrompt : SYSTEM_PROMPT;

  const KEEP_RECENT = 6; // Keep last 6 messages (~3 exchanges)

  if (messages.length <= KEEP_RECENT) {
    const serialized = serializeMessages(systemPrompt, messages);
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

    const serialized = serializeMessages(systemPrompt, compactedMessages);
    const tokenCount = Math.round(serialized.length / 3.5);

    // Auto-save compacted messages for agent instances
    if (agentId) {
      try {
        saveAgentMessages(agentId, compactedMessages, tokenCount);
      } catch (e) {
        console.warn("[agentStore] compact save failed:", e.message);
      }
    }

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

// ---------------------------------------------------------------------------
// Document upload / knowledge base endpoints
// ---------------------------------------------------------------------------

app.get("/api/documents", async (req, res) => {
  try {
    let docQuery = supabase
      .from("documents")
      .select("id, filename, metadata, created_at")
      .eq("user_id", PERSONAL_USER_ID)
      .order("created_at", { ascending: false });

    if (req.query.agentId) {
      docQuery = docQuery.eq("metadata->>agent_id", req.query.agentId);
    }

    const { data, error } = await docQuery;

    if (error) throw error;

    // Attach chunk counts
    const ids = (data ?? []).map((d) => d.id);
    let chunkCounts = {};
    if (ids.length > 0) {
      const { data: chunks } = await supabase
        .from("document_chunks")
        .select("document_id")
        .in("document_id", ids);
      for (const c of chunks ?? []) {
        chunkCounts[c.document_id] = (chunkCounts[c.document_id] ?? 0) + 1;
      }
    }

    res.json((data ?? []).map((d) => ({ ...d, chunkCount: chunkCounts[d.id] ?? 0 })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/documents/upload", upload.array("files"), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  // Build metadata from agentId if provided (multer populates req.body from multipart text fields)
  const { agentId } = req.body;
  let uploadMetadata = {};
  if (agentId) {
    const agentInstance = getAgent(agentId);
    if (agentInstance) {
      uploadMetadata = {
        agent_id: agentInstance.id,
        agent_name: agentInstance.name,
        archetype_id: agentInstance.archetypeId ?? null,
      };
      if (agentInstance.variables?.BOOK_TITLE) uploadMetadata.book_title = agentInstance.variables.BOOK_TITLE;
      if (agentInstance.variables?.AUTHOR) uploadMetadata.author = agentInstance.variables.AUTHOR;
    }
  }

  const results = [];

  for (const file of req.files) {
    const filename = file.originalname;
    try {
      // Parse content from buffer (handles text, code, PDF, DOCX via docling-serve)
      const content = await parseFile(file.buffer, filename);

      // Chunk the document
      const chunks = chunkText(content);

      // Generate embeddings for all chunks
      const texts = chunks.map((c) => c.content);
      const embeddings = await generateEmbeddings(texts);

      // Insert document record
      const { data: docData, error: docErr } = await supabase
        .from("documents")
        .insert({
          user_id: PERSONAL_USER_ID,
          filename,
          content,
          file_type: filename.split(".").pop() ?? "txt",
          file_size: file.buffer.length,
          storage_path: filename,
          status: "completed",
          metadata: uploadMetadata,
        })
        .select("id")
        .single();

      if (docErr) throw new Error(`DB insert failed: ${docErr.message}`);
      const documentId = docData.id;

      // Insert chunks with embeddings
      const chunkRows = chunks.map((chunk, i) => ({
        document_id: documentId,
        user_id: PERSONAL_USER_ID,
        content: chunk.content,
        chunk_index: chunk.chunkIndex,
        embedding: embeddings[i],
      }));

      const { error: chunkErr } = await supabase.from("document_chunks").insert(chunkRows);
      if (chunkErr) throw new Error(`Chunk insert failed: ${chunkErr.message}`);

      results.push({ filename, status: "ok", documentId, chunkCount: chunks.length });
      console.log(`[upload] indexed "${filename}" → ${chunks.length} chunks`);
    } catch (err) {
      console.error(`[upload] failed for "${filename}":`, err.message);
      results.push({ filename, status: "error", error: err.message });
    }
  }

  res.json({ results });
});

app.delete("/api/documents/:id", async (req, res) => {
  try {
    // Chunks are deleted by cascade (FK constraint) in Supabase
    const { error } = await supabase
      .from("documents")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", PERSONAL_USER_ID);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Server startup — listen immediately so static endpoints work before MCP connects
// ---------------------------------------------------------------------------

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
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

  console.log("All tools loaded. Ready.");
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[server] shutting down...");
  registry?.stopAll();
  process.exit(0);
});

start();
