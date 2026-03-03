# Local AI Personal Assistant

A continuously-running personal assistant with a React web UI and Express API, powered by locally-running LM Studio models. Features streaming chat, tool calling, RAG-powered knowledge base, Google Calendar integration, autonomous background monitors, reusable agent archetypes, and a CLI eval system.

Inspired by Scott Moss' Frontend Masters course — built to run locally without burning API budget.

## Features

- **Streaming chat** — SSE-based streaming with live token usage and context-window progress bar
- **Think bubbles** — collapsible reasoning blocks for thinking models (Qwen3, DeepSeek-R1, QwQ); stream live as they arrive
- **Tool calling** — file ops, directory navigation, Google Calendar, web search (Tavily MCP), RAG search, research sub-agent
- **Context compaction** — auto-compacts at 80% context usage; manual compact button always available
- **Agent archetypes** — reusable prompt templates with variable substitution (Interview Preparer, Tutor, Book Study Helper, Scheduler, Guitar Teacher, News Briefing)
- **Agent instances** — persistent per-agent conversation history saved to disk; restored on reload
- **Knowledge base** — Supabase-backed pgvector store; hybrid vector + keyword search with RRF fusion; drag-drop upload in UI or CLI indexing
- **Background monitors** — Calendar monitor (upcoming-event alerts), News monitor (scheduled AI briefings)
- **Eval system** — CLI tool to benchmark tool-call routing accuracy across models; exports passing cases as fine-tuning JSONL

---

## Prerequisites

- **Node.js** v20+
- **LM Studio** running locally with at least one LLM loaded
- **Supabase** running locally for RAG / knowledge base (`npx supabase start` in the masterclass directory)
- **Embedding model** loaded in LM Studio — must be 768-dim (e.g. `text-embedding-nomic-embed-text-v1.5`)
- **Tavily API key** for web search ([tavily.com](https://tavily.com))
- **Google service account** credentials for Calendar integration (see setup below)

---

## Installation

```bash
npm install
cd client && npm install && cd ..
```

---

## Quick Start

```bash
npm start          # API server (port 3000) + React dev UI (port 5173)
```

Open `http://localhost:5173`. Or for terminal-only mode:

```bash
node run.js
```

---

## Environment Variables

Create `.env` in the project root:

| Variable | Default | Description |
|---|---|---|
| `LMSTUDIO_BASE_URL` | `http://localhost:1234/v1` | LM Studio OpenAI-compatible endpoint |
| `MAIN_LLM` | first loaded model | Preferred model ID or substring (e.g. `qwen3`) |
| `PORT` | `3000` | Express server port |
| `EMBEDDING_MODEL` | — | LM Studio embedding model ID (must be 768-dim) |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | Local Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase service role key (bypasses RLS) |
| `SUPABASE_ANON_KEY` | — | Supabase anon key |
| `EMBEDDING_DIMENSIONS` | `768` | Embedding vector dimensions |
| `SEARCH_MODE` | `hybrid` | RAG search strategy: `vector`, `keyword`, or `hybrid` |
| `RERANK_ENABLED` | `false` | Enable LLM-based result reranking (adds latency) |
| `TAVILY_API_KEY` | — | Tavily web search API key |
| `CALENDAR_POLL_INTERVAL_MS` | `60000` | How often the calendar monitor polls (ms) |
| `CALENDAR_LOOKAHEAD_MINUTES` | `15` | Window for upcoming-event alerts |
| `LMNR_PROJECT_API_KEY` | — | Laminar tracing API key (optional) |

---

## Architecture

```
React UI (Vite, :5173)
    │  SSE + HTTP /api/*
    ▼
Express API (server.js, :3000)
    ├── POST /api/chat             — Streaming chat + tool loop (optional agentId)
    ├── POST /api/compact          — LLM-based context compaction (optional agentId)
    ├── GET  /api/context-info     — Model context window size
    ├── GET  /api/archetypes       — List archetypes
    ├── GET  /api/agents           — List agent instances
    ├── POST /api/agents           — Create agent instance
    ├── GET  /api/agents/:id       — Full instance with message history
    ├── PATCH /api/agents/:id      — Rename agent
    ├── DELETE /api/agents/:id     — Delete agent
    ├── POST /api/agents/:id/run-briefing — Manual news briefing trigger
    ├── GET  /api/documents        — List indexed KB documents
    ├── POST /api/documents/upload — Upload + index a document
    └── DELETE /api/documents/:id  — Delete document + chunks

Tool Layer (tools/)
    ├── File ops:      readFile, writeFile, deleteFile
    ├── Directory ops: listFiles, changeDirectory, currentDirectory
    ├── dateTime
    ├── Google Calendar: listCalendars, setActiveCalendar, listEvents,
    │                    addEvent, editEvent, deleteEvent
    ├── webSearch (Tavily MCP — factory)
    ├── ragSearch (Supabase hybrid search — factory)
    └── delegateResearch (research sub-agent — factory)

Agent Layer (agents/)
    └── researchAgent — streamText loop with web search + RAG,
                        isolated context budget (50% of window)

Monitor Layer (monitors/)
    ├── calendarMonitor — polls Google Calendar; fires upcoming-event alerts
    └── newsMonitor     — runs scheduled news-briefing agents every 5 min

Library Layer (lib/)
    ├── retrieval.js   — hybrid vector + keyword search with RRF fusion
    ├── embeddings.js  — Vercel AI SDK embed() / embedMany()
    ├── chunking.js    — paragraph-aware text chunking with overlap
    ├── reranker.js    — optional LLM-based result reranking
    ├── agentStore.js  — CRUD for archetypes + agent instances (JSON on disk)
    └── supabase.js    — Supabase admin client

Storage
    └── Supabase (local Docker)
        ├── documents table       — indexed document metadata
        └── document_chunks table — chunked text + pgvector embeddings (768-dim)
```

All inference uses the **Vercel AI SDK** (`@ai-sdk/openai-compatible` + `ai`) exclusively — no LMStudio SDK dependency at runtime.

---

## Agent Archetypes

Archetypes are reusable prompt templates in `archetypes/*.json`. Create an instance via the **New Agent** button in the sidebar, fill in any variables, and the conversation is persisted automatically.

| Archetype | Description |
|---|---|
| Interview Preparer | Practice technical/behavioral interviews for a target role and company |
| Tutor | Adaptive tutoring on any subject with recall testing |
| Book Study Helper | Deep reading companion for a specific book |
| Scheduler | Calendar-focused assistant for planning and scheduling |
| Guitar Teacher | Guided lessons from beginner to advanced |
| News Briefing | Scheduled web-search agent that delivers daily digests |

### Creating archetypes

Add a JSON file to `archetypes/`:

```json
{
  "id": "my-archetype",
  "name": "Display Name",
  "description": "Shown in the archetype picker",
  "icon": "🤖",
  "systemPrompt": "You are... Today is {{DATE}}. The topic is {{TOPIC}}.",
  "tools": ["dateTime", "ragSearch"],
  "defaultInstanceName": "My Agent",
  "variables": {
    "TOPIC": { "label": "Topic", "required": true, "default": null }
  }
}
```

`{{DATE}}` and `{{VARIABLE_NAME}}` placeholders are resolved at instance creation time.

---

## Knowledge Base

> **Embedding model requirement:** The schema uses `vector(768)`. Load a 768-dim model in LM Studio (e.g. `text-embedding-nomic-embed-text-v1.5`) before indexing.

### Web UI

Use the **Knowledge Base** button in the sidebar to drag-drop files or see what's indexed. Supported file types: `.txt`, `.md`, `.js`, `.ts`, `.jsx`, `.tsx`, `.json`, `.css`, `.html`, and more.

### CLI

```bash
node embed.js index <directory>   # recursively chunk, embed, and index text files
node embed.js search "<query>"    # test hybrid search
node embed.js stats               # document and chunk counts
node embed.js clear               # delete all documents and chunks
```

### Starting Supabase

```bash
cd ../ragtut/claude-code-agentic-rag-masterclass && npx supabase start
```

---

## Google Calendar Setup

1. Create a Google Cloud service account and download its JSON key to `creds/google.json`
2. Create `creds/calendar-config.json`:
   ```json
   { "activeCalendar": "your-email@gmail.com", "timezone": "America/New_York" }
   ```
3. Share your calendar with the service account email (grant "Make changes to events" at minimum)

---

## Background Monitors

Monitors start automatically with the server.

**Calendar monitor** — polls Google Calendar on a configurable interval and logs upcoming events within the lookahead window. Configure via `CALENDAR_POLL_INTERVAL_MS` and `CALENDAR_LOOKAHEAD_MINUTES`.

**News monitor** — checks every 5 minutes whether any News Briefing agent instances are due to run. When triggered, the agent searches the web and appends a briefing to its conversation history. Manually trigger with `POST /api/agents/:id/run-briefing`.

### Adding new monitors

Implement the interface and register it in `server.js`:

```js
// monitors/yourMonitor.js
export function createYourMonitor(opts) {
  return {
    onEvent(handler) { /* register callback */ },
    start(intervalMs)  { /* start polling */ },
    stop()             { /* clear interval */ },
    async getUpcoming() { /* return upcoming items */ },
  };
}
```

```js
// server.js
registry.register("yourMonitor", createYourMonitor(opts));
```

---

## Eval System

Benchmark tool-call routing accuracy for any loaded model. Useful for comparing models before fine-tuning decisions, and for generating training data.

```bash
node eval.js                                    # all suites, current model
node eval.js --suite evals/tool-selection.json  # specific suite file
node eval.js --model qwen3                      # substring model filter
node eval.js --all-models                       # all loaded LLMs + comparison table
node eval.js --export-finetune out.jsonl        # export passing cases as JSONL
```

**Sample output:**
```
Suite: Tool Selection — Core Coverage

  Model: qwen3-8b-instruct
  ────────────────────────────────────────────────────────────────────────
  PASS  datetime-current-time          tools=[dateTime]       612ms  340tok
  FAIL  no-tool-simple-math            tools=[dateTime]       580ms  310tok
       reason: expected no tool call, got: dateTime
  ────────────────────────────────────────────────────────────────────────
  Summary: 13/14 passed  avg 720ms  4820 total tokens
```

**Eval suite format** (`evals/*.json`):

```json
{
  "name": "Suite Name",
  "systemPrompt": "You are a helpful assistant...",
  "cases": [
    {
      "id": "datetime-current-time",
      "messages": [{ "role": "user", "content": "What time is it?" }],
      "expect": { "toolCalls": ["dateTime"] }
    },
    {
      "id": "no-tool-math",
      "messages": [{ "role": "user", "content": "What is 2 + 2?" }],
      "expect": { "noToolCall": true }
    },
    {
      "id": "calendar-reschedule",
      "messages": [{ "role": "user", "content": "Move my 3pm meeting to 4pm" }],
      "expect": { "anyOf": ["listEvents", "editEvent"] }
    }
  ]
}
```

`expect` options: `toolCalls` (all listed tools must appear), `anyOf` (at least one must appear), `noToolCall: true`. Optional per-case overrides: `systemPrompt`, `tools` (list of tool names to expose).

`--export-finetune` writes passing tool-call cases as OpenAI-format JSONL, compatible with Axolotl / LLaMA-Factory / Unsloth.

---

## Project Structure

```
server.js             Express API + SSE streaming
run.js                Standalone terminal chat
eval.js               Eval CLI runner
embed.js              Knowledge base indexing CLI
system-prompt.txt     Main assistant system prompt ({{DATE}} placeholder)
personal.txt          User personal info referenced by system prompt

tools/                Tool definitions (Vercel AI SDK + Zod)
agents/               Research sub-agent + delegate tool
monitors/             Calendar + news background monitors
lib/                  RAG, embeddings, chunking, reranker, agentStore, Supabase client
archetypes/           Agent archetype JSON templates
agent-instances/      Persisted agent conversations (gitignored)
evals/                Eval suite JSON files
creds/                Google service account credentials (gitignored)
client/               React + Vite frontend
```
