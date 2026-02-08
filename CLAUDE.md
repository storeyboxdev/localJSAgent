# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chat agent with a React web UI and Express API backend, powered by locally-running LM Studio models. Uses the Vercel AI SDK for streaming inference and tool calling, with the LM Studio SDK for model metadata (context length, token counting).

## Running the Application

Requires LM Studio running locally with a model loaded.

```bash
node server.js          # Express API server (port 3000)
cd client && npm run dev # React dev server (Vite, proxies /api to :3000)
node run.js             # Standalone terminal chat (no web UI)
```

The project uses ESM (`"type": "module"` in package.json).

## Architecture

### Backend (`server.js`)

Express API with SSE streaming. Connects to LM Studio via two SDK paths:

- **Vercel AI SDK** (`@ai-sdk/openai-compatible` + `ai`) — `streamText()` for chat inference and tool execution
- **LM Studio SDK** (`@lmstudio/sdk`) — `LMStudioClient` for `getContextLength()` and `countTokens()`

**Endpoints:**
- `POST /api/chat` — Streams chat responses via SSE (events: `text`, `tool-call`, `tool-result`, `done`, `error`). The `done` event includes `tokenCount`, `contextLength`, and `shouldCompact` flag.
- `GET /api/context-info` — Returns `{ contextLength }` for the model's context window size.
- `POST /api/compact` — LLM-based context compaction. Summarizes older messages, keeps last 6 (3 exchanges) verbatim, returns compacted message array with updated token count.

**Key features:**
- Tag suppression filter (`<think>`, `<arg_key>`, `<arg_value>`) for thinking models
- Tool execution loop (capped at 5 rounds)
- Auto-compact threshold at 80% context usage
- MCP integration with Tavily for web search

### Frontend (`client/`)

React 19 + Vite single-page app.

- `App.jsx` — Main component: message list, SSE streaming, status bar with token usage display and compact button
- Messages stored in two forms: display messages (state) and full API message history (ref)
- Auto-compaction triggered when server signals `shouldCompact: true`

### Tools (`tools/`)

Defined using `tool()` from Vercel AI SDK with Zod parameter schemas. Registered in `tools/index.js`.

- `dateTime` — Current ISO timestamp
- `readFile`, `writeFile`, `deleteFile` — File operations
- `listFiles`, `changeDirectory`, `currentDirectory` — Directory operations
- `webSearch` — Tavily MCP-based web search (factory function taking mcpClient)

### Other files

- `run.js` — Standalone terminal chat app (readline-based, same Vercel AI SDK pattern as server)
- `example.js` — SDK example with a createFile tool
- `example2.js` — Minimal chat example (no tools)

## Dependencies

**Root (backend + terminal):**
- `@ai-sdk/openai-compatible` — OpenAI-compatible provider for Vercel AI SDK
- `@ai-sdk/mcp` — MCP client for tool integration
- `@lmstudio/sdk` — LM Studio SDK (context length, token counting)
- `ai` — Vercel AI SDK (streamText, tool definitions)
- `express` / `cors` — Web server
- `openai` — OpenAI client (legacy, used in examples)

**Client:**
- `react` / `react-dom` — UI framework
- `vite` — Build tool + dev server
