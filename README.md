# Local JS Agent

A chat agent with a React web UI and Express API backend, powered by locally-running LM Studio models. Features tool calling (file ops, web search), streaming responses, token counting, and context compaction.

I was inspired by Scott Moss' Frontend Masters course https://frontendmasters.com/courses/ai-agents-v2/ that uses node to build agents. I wanted the flexibility to play and not run up bills so I incorporated lm studio and I am getting so-so results from my 16gb 5070ti but I ain't going broke ( from this at least )

## Prerequisites

- **Node.js** (v18+)
- **LM Studio** running locally with a model loaded

## Installation

```bash
git clone https://github.com/storeyboxdev/localJSAgent.git
cd localJSAgent
npm install
cd client && npm install
```

## Environment Setup

Create a `.env` file in the project root:

```
LMSTUDIO_BASE_URL=http://localhost:1234/v1
TAVILY_API_KEY=your_tavily_api_key_here
PORT=3000
```

| Variable            | Description                                                      | Default                    |
| ------------------- | ---------------------------------------------------------------- | -------------------------- |
| `LMSTUDIO_BASE_URL` | LM Studio server URL                                             | `http://localhost:1234/v1` |
| `TAVILY_API_KEY`    | API key for Tavily web search ([tavily.com](https://tavily.com)) | —                          |
| `PORT`              | Express server port                                              | `3000`                     |

The model is detected automatically from whatever is loaded in LM Studio — no need to configure it.

## Running

Start LM Studio and load a model, then:

```bash
# Start the API server
node server.js

# In a separate terminal, start the React dev server
cd client
npm run dev
```

Open `http://localhost:5173` in your browser.

### Terminal-only mode

For a standalone terminal chat (no web UI):

```bash
node run.js
```

## Features

- Streaming chat responses via SSE
- Tool calling: file read/write/delete, directory listing, web search
- Token counting with context usage display
- Manual and automatic context compaction (LLM-based summarization)
- Tag suppression for thinking models (`<think>` tags hidden from output)
