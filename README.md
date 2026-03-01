# Local AI Personal Assistant

A continuously-running personal assistant with a React web UI and Express API, powered by locally-running LM Studio models. Includes background calendar monitoring, a RAG-powered research sub-agent, hybrid vector+keyword document search (Supabase), tool calling, and streaming chat.

Inspired by Scott Moss' Frontend Masters course — built to run locally without burning API budget.

## Prerequisites

- **Node.js** (v18+)
- **LM Studio** running locally with a model loaded (and an embedding model loaded for RAG)
- **Supabase** running locally (from the RAG masterclass setup, or `npx supabase start`)
- **Tavily API key** for web search ([tavily.com](https://tavily.com))
- **Google service account** credentials for Calendar integration (`creds/google.json`, `creds/calendar-config.json`)

## Installation

```bash
npm install
cd client && npm install
```

## Quick Start

```bash
npm start
```

This starts both the API server (port 3000) and the React dev UI (port 5173) in one command.

Open `http://localhost:5173` in your browser.

### Terminal-only mode

```bash
node run.js
```

## Environment Variables

Create or update `.env` in the project root:

| Variable | Description | Default |
|---|---|---|
| `LMSTUDIO_BASE_URL` | LM Studio OpenAI-compatible endpoint | `http://localhost:1234/v1` |
| `TAVILY_API_KEY` | Tavily web search API key | — |
| `PORT` | Express server port | `3000` |
| `EMBEDDING_MODEL` | LM Studio embedding model ID — **must match Supabase schema dimension** | `text-embedding-nomic-embed-text-v1.5` (768-dim) |
| `SUPABASE_URL` | Local Supabase URL | `http://127.0.0.1:54321` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (bypasses RLS) | — |
| `SUPABASE_ANON_KEY` | Supabase anon key | — |
| `EMBEDDING_DIMENSIONS` | Embedding vector dimensions | `768` |
| `SEARCH_MODE` | RAG search strategy: `vector`, `keyword`, or `hybrid` | `hybrid` |
| `RERANK_ENABLED` | Enable LLM-based result reranking (adds latency) | `false` |
| `CALENDAR_POLL_INTERVAL_MS` | How often calendar monitor polls (ms) | `60000` |
| `CALENDAR_LOOKAHEAD_MINUTES` | How far ahead to look for events | `15` |

The LLM model is auto-detected from whatever is loaded in LM Studio.

## Architecture

```
React UI (Vite, :5173)
    │  SSE + HTTP /api/*
    ▼
Express API (server.js, :3000)
    ├── POST /api/chat        — Streaming chat with tool execution loop
    ├── POST /api/compact     — LLM-based context compaction
    ├── GET  /api/context-info — Model context window size
    └── GET  /api/monitors    — Monitor status + upcoming calendar events

Tool Layer (tools/)
    ├── File ops: readFile, writeFile, deleteFile
    ├── Directory ops: listFiles, changeDirectory, currentDirectory
    ├── dateTime
    ├── Google Calendar: listCalendars, setActiveCalendar, listEvents, addEvent, editEvent, deleteEvent
    ├── webSearch (Tavily MCP)
    ├── ragSearch (Supabase hybrid search — factory)
    └── delegateResearch (research sub-agent — factory)

Agent Layer (agents/)
    └── researchAgent — uses LMStudio SDK .act() with isolated context budget (50% of window)
                        tools: ragSearch + webSearch only

Monitor Layer (monitors/)
    └── calendarMonitor — polls Google Calendar on interval, fires event callbacks
        (extensible: add fileWatchMonitor, newsMonitor, etc.)

Library Layer (lib/)
    ├── retrieval.js   — hybrid vector+keyword search with RRF fusion
    ├── embeddings.js  — LMStudio embedding generation
    ├── chunking.js    — paragraph-aware text chunking with overlap
    ├── reranker.js    — optional LLM-based result reranking
    ├── keyword-search.js — Postgres full-text search via Supabase
    └── supabase.js    — Supabase admin client

Storage
    └── Supabase (local Docker)
        ├── documents table       — indexed document metadata
        └── document_chunks table — chunked text + pgvector embeddings
```

## SDK Decision Framework

Two SDKs are used situationally:

| Scenario | SDK Used |
|---|---|
| Interactive chat with user | Vercel AI SDK (`streamText`) |
| Tool calls visible in UI | Vercel AI SDK |
| Research sub-agent (autonomous) | LMStudio SDK (`.act()`) |
| Background monitor tasks | Native setInterval |

Both connect to the same single LM Studio model — no parallel model loading required.

## Knowledge Base (RAG)

> **Embedding model requirement:** The Supabase schema is configured for `vector(768)` dimensions. Load `text-embedding-nomic-embed-text-v1.5` (or any 768-dim model) in LM Studio before indexing. If you switch to a different dimension, run a migration to alter the `document_chunks.embedding` column and recreate `match_document_chunks`.

Index local files into the vector store so the agent can retrieve personal context:

```bash
# Index a directory (recursively processes .js, .ts, .md, .txt, .json, .html, .css)
node embed.js index <directory>

# Check what's indexed
node embed.js stats

# Search (for testing)
node embed.js search "your query"

# Clear all indexed data
node embed.js clear
```

Documents are stored in Supabase with embeddings for hybrid vector+keyword search. The `ragSearch` tool is automatically available in chat.

## Tools Reference

| Tool | Description |
|---|---|
| `readFile` | Read a file |
| `writeFile` | Write or create a file |
| `deleteFile` | Delete a file |
| `listFiles` | List directory contents |
| `changeDirectory` | Change working directory |
| `currentDirectory` | Get current directory |
| `dateTime` | Current date/time |
| `listCalendars` | List Google Calendars |
| `setActiveCalendar` | Switch active calendar |
| `listEvents` | List upcoming events |
| `addEvent` | Create calendar event |
| `editEvent` | Update calendar event |
| `deleteEvent` | Delete calendar event |
| `webSearch` | Search the web (Tavily) |
| `ragSearch` | Search personal knowledge base |
| `delegateResearch` | Delegate to research sub-agent |

## Adding New Monitors

Create `monitors/yourMonitor.js` following the `calendarMonitor.js` pattern:

```js
export function createYourMonitor(opts) {
  return {
    onEvent(handler) { ... },
    start(intervalMs) { ... },
    stop() { ... },
    async getUpcoming() { ... },
  };
}
```

Then register in `server.js`:

```js
registry.register("yourMonitor", createYourMonitor(opts));
```

## Features

- Streaming chat via SSE with real-time token usage display
- Tool calling with full execution loop (max 5 rounds)
- Hybrid RAG: vector + keyword search with Reciprocal Rank Fusion
- Optional LLM-based result reranking
- Research sub-agent with isolated context budget (50% of window)
- Background calendar monitoring with configurable lookahead
- Manual and automatic context compaction at 80% usage
- Tag suppression for thinking models (`<think>` hidden from output)
- Single `npm start` command for both servers
