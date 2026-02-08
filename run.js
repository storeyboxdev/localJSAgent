// run.js - Terminal-based chat app using Vercel AI SDK + LM Studio

import "dotenv/config";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMCPClient } from "@ai-sdk/mcp";
import { LMStudioClient } from "@lmstudio/sdk";
import { streamText } from "ai";
import { createInterface } from "readline/promises";
import { tools } from "./tools/index.js";
import { createWebSearch } from "./tools/webSearch.js";

const provider = createOpenAICompatible({
  name: "lmstudio",
  apiKey: "lm-studio",
  baseURL: process.env.LMSTUDIO_BASE_URL,
});

// Tag filter: suppresses content inside <think>, <arg_key>, <arg_value> tags
const SUPPRESS_TAGS = ["think", "arg_key", "arg_value"];
const MAX_OPEN_LEN = Math.max(...SUPPRESS_TAGS.map((t) => `<${t}>`.length));
const MAX_CLOSE_LEN = Math.max(...SUPPRESS_TAGS.map((t) => `</${t}>`.length));

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

async function main() {
  const client = new LMStudioClient();
  const lmmodel = await client.llm.model();
  const modelInfo = await lmmodel.getModelInfo();
  const model = provider(modelInfo.path);
  console.log(`Model: ${modelInfo.path}`);

  console.log("Connecting to Tavily MCP server...");
  const mcpClient = await createMCPClient({
    transport: {
      type: "http",
      url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${process.env.TAVILY_API_KEY}`,
    },
  });
  const webSearch = createWebSearch(mcpClient);
  const allTools = { ...tools, webSearch };

  console.log("Welcome to the Terminal Chat App!");

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const SYSTEM_PROMPT =
    "You are a helpful personal assistant. Please make all responses in English.";

  const messages = [];

  console.log(
    'Type your message and press Enter to send. Type "exit" to quit.',
  );

  while (true) {
    const input = await rl.question("You: ");
    if (input.trim().toLowerCase() === "exit") {
      console.log("Goodbye!");
      await mcpClient.close();
      rl.close();
      process.exit(0);
    }

    messages.push({ role: "user", content: input });

    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIdx = 0;
    let firstFragment = true;
    const spinnerTimer = setInterval(() => {
      process.stdout.write(
        `\r${spinner[spinnerIdx++ % spinner.length]} Thinking...`,
      );
    }, 80);

    process.stdout.write(`\r${spinner[0]} Thinking...`);

    // Tool execution loop: call model, execute any tool calls, repeat
    const MAX_TOOL_ROUNDS = 5;
    let toolRound = 0;
    while (true) {
      let insideTag = null;
      let buffer = "";
      const toolCalls = [];

      const result = streamText({
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: allTools,
      });

      for await (const chunk of result.fullStream) {
        if (chunk.type === "text-delta") {
          if (firstFragment) {
            clearInterval(spinnerTimer);
            process.stdout.write("\r\x1b[KBot: ");
            firstFragment = false;
          }
          buffer += chunk.text;
          const state = processBuffer(buffer, insideTag, (text) => {
            if (text) process.stdout.write(text);
          });
          buffer = state.buffer;
          insideTag = state.insideTag;
        } else if (chunk.type === "tool-call") {
          toolCalls.push(chunk);
          // Discard buffer on tool call — it likely contains leaked arg tags
          buffer = "";
          insideTag = null;
          if (firstFragment) {
            clearInterval(spinnerTimer);
            process.stdout.write("\r\x1b[KBot: ");
            firstFragment = false;
          }
          process.stdout.write(`\n  [calling ${chunk.toolName}...]\n`);
        }
      }

      // Flush remaining text buffer
      if (!insideTag && buffer.length > 0) {
        process.stdout.write(buffer);
      }

      // Append assistant response to message history
      const response = await result.response;
      messages.push(...response.messages);

      // If no tool calls, we have the final response — done
      if (toolCalls.length === 0) break;

      // Cap iterations to prevent runaway tool loops
      if (++toolRound >= MAX_TOOL_ROUNDS) {
        process.stdout.write("\n  [max tool rounds reached]\n");
        break;
      }

      // SDK already executed tools and included results in response.messages
      // Loop back — call the model again so it can respond with the tool results
    }

    clearInterval(spinnerTimer);
    if (firstFragment) {
      process.stdout.write("\r\x1b[KBot: ");
    }
    process.stdout.write("\n");
  }
}

main();
