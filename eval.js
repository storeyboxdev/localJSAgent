#!/usr/bin/env node
// eval.js — CLI eval runner for tool-call selection

import "dotenv/config";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, tool } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Arg parsing ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const getArg = (flag) => { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; };
const hasFlag = (flag) => argv.includes(flag);

const suiteArg    = getArg("--suite");
const modelFilter = getArg("--model");
const allModels   = hasFlag("--all-models");
const exportPath  = getArg("--export-finetune");

// ── Tool loading (eval-safe) ──────────────────────────────────────────────────

// Replace execute with a no-op so tool schemas are present but nothing side-effects
function stripExecute(t) {
  const { execute: _x, ...rest } = t;
  return { ...rest, execute: async () => ({}) };
}

// Static tools — safe to import at module level (no top-level awaits)
import { dateTime }        from "./tools/dateTime.js";
import { readFile }        from "./tools/readFile.js";
import { writeFile }       from "./tools/writeFile.js";
import { deleteFile }      from "./tools/deleteFile.js";
import { listFiles }       from "./tools/listFiles.js";
import { changeDirectory } from "./tools/changeDirectory.js";
import { currentDirectory } from "./tools/currentDirectory.js";

// Calendar tools — may fail when Google creds are absent; fall back to stubs
let calendarTools = {};
let calendarLoaded = false;
try {
  const gc = await import("./tools/gcalendar.js");
  calendarTools = {
    listCalendars:    gc.listCalendars,
    setActiveCalendar: gc.setActiveCalendar,
    listEvents:       gc.listEvents,
    addEvent:         gc.addEvent,
    editEvent:        gc.editEvent,
    deleteEvent:      gc.deleteEvent,
  };
  calendarLoaded = true;
} catch {
  // Build minimal stubs — accurate descriptions so routing decisions are realistic
  const mk = (desc, schema) => tool({ description: desc, inputSchema: schema, execute: async () => ({}) });
  calendarTools = {
    listCalendars: mk(
      "List all Google Calendars accessible by the service account. Shows calendar name, ID, and whether it is the currently active calendar.",
      z.object({})
    ),
    setActiveCalendar: mk(
      "Switch the active Google Calendar. All subsequent calendar operations will use this calendar by default.",
      z.object({ calendarId: z.string().describe("The calendar ID to set as active") })
    ),
    listEvents: mk(
      "List upcoming events from Google Calendar. Use this to check what's on the calendar.",
      z.object({
        calendarId:  z.string().optional().describe("Calendar ID (defaults to active)"),
        maxResults:  z.number().default(10).describe("Maximum number of events to return"),
        timeMin:     z.string().optional().describe("ISO date string to filter events from"),
      })
    ),
    addEvent: mk(
      "Create a new event on Google Calendar. Use allDay=true with startDate/endDate for all-day events, or startDateTime/endDateTime for timed events.",
      z.object({
        summary:       z.string().describe("Title of the event"),
        calendarId:    z.string().optional(),
        description:   z.string().optional(),
        allDay:        z.boolean().optional(),
        startDate:     z.string().optional().describe("YYYY-MM-DD for all-day events"),
        endDate:       z.string().optional(),
        startDateTime: z.string().optional().describe("ISO 8601 string for timed events"),
        endDateTime:   z.string().optional(),
        location:      z.string().optional(),
        recurrence:    z.array(z.string()).optional().describe("iCalendar RRULE strings"),
      })
    ),
    editEvent: mk(
      "Update an existing Google Calendar event. Only the provided fields will be changed.",
      z.object({
        eventId:       z.string().describe("ID of the event to update"),
        calendarId:    z.string().optional(),
        summary:       z.string().optional(),
        description:   z.string().optional(),
        startDateTime: z.string().optional(),
        endDateTime:   z.string().optional(),
        startDate:     z.string().optional(),
        endDate:       z.string().optional(),
        allDay:        z.boolean().optional(),
        location:      z.string().optional(),
        recurrence:    z.array(z.string()).optional(),
      })
    ),
    deleteEvent: mk(
      "Delete an event from Google Calendar by its event ID.",
      z.object({
        eventId:    z.string().describe("ID of the event to delete"),
        calendarId: z.string().optional(),
      })
    ),
  };
}

// Gmail tools — may fail when OAuth creds are absent; fall back to stubs
let gmailTools = {};
let gmailLoaded = false;
try {
  const gm = await import("./tools/gmail.js");
  gmailTools = {
    searchEmails:  gm.searchEmails,
    readEmail:     gm.readEmail,
    sendEmail:     gm.sendEmail,
    replyToEmail:  gm.replyToEmail,
    forwardEmail:  gm.forwardEmail,
    trashEmail:    gm.trashEmail,
    archiveEmail:  gm.archiveEmail,
    markAsRead:    gm.markAsRead,
  };
  gmailLoaded = true;
} catch {
  const mk = (desc, schema) => tool({ description: desc, inputSchema: schema, execute: async () => ({}) });
  gmailTools = {
    searchEmails: mk(
      "Search your Gmail inbox using Gmail search syntax. Returns a list of messages with id, threadId, subject, from, date, and snippet.",
      z.object({
        q:          z.string().describe("Gmail search query (e.g. \"from:bob is:unread\", \"subject:invoice\")"),
        maxResults: z.number().default(10).describe("Maximum number of results to return"),
      })
    ),
    readEmail: mk(
      "Read the full content of an email by its messageId. Returns subject, from, to, date, and body.",
      z.object({ messageId: z.string().describe("The Gmail message ID to read") })
    ),
    sendEmail: mk(
      "Compose and send a new email. Requires to, subject, and body.",
      z.object({
        to:      z.string().describe("Recipient email address"),
        subject: z.string().describe("Email subject line"),
        body:    z.string().describe("Email body (plain text)"),
        cc:      z.string().optional().describe("CC recipients"),
      })
    ),
    replyToEmail: mk(
      "Reply to an existing email thread by messageId.",
      z.object({
        messageId: z.string().describe("The Gmail message ID to reply to"),
        body:      z.string().describe("Reply text"),
      })
    ),
    forwardEmail: mk(
      "Forward an email to a new recipient. Optionally prepend a note.",
      z.object({
        messageId: z.string().describe("The Gmail message ID to forward"),
        to:        z.string().describe("Recipient to forward to"),
        note:      z.string().optional().describe("Optional note to prepend"),
      })
    ),
    trashEmail: mk(
      "Move an email to the trash by its messageId.",
      z.object({ messageId: z.string().describe("The Gmail message ID to trash") })
    ),
    archiveEmail: mk(
      "Archive an email (remove from inbox) by its messageId.",
      z.object({ messageId: z.string().describe("The Gmail message ID to archive") })
    ),
    markAsRead: mk(
      "Mark an email as read or unread.",
      z.object({
        messageId: z.string().describe("The Gmail message ID"),
        read:      z.boolean().describe("true to mark as read, false to mark as unread"),
      })
    ),
  };
}

const ALL_TOOLS = {
  dateTime:         stripExecute(dateTime),
  readFile:         stripExecute(readFile),
  writeFile:        stripExecute(writeFile),
  deleteFile:       stripExecute(deleteFile),
  listFiles:        stripExecute(listFiles),
  changeDirectory:  stripExecute(changeDirectory),
  currentDirectory: stripExecute(currentDirectory),
  ...Object.fromEntries(
    Object.entries(calendarTools).map(([k, v]) => [k, stripExecute(v)])
  ),
  ...Object.fromEntries(
    Object.entries(gmailTools).map(([k, v]) => [k, stripExecute(v)])
  ),
};

// ── Model loading ─────────────────────────────────────────────────────────────

const apiBase = (process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1").replace(/\/v1\/?$/, "");

async function fetchLoadedLLMs() {
  const res = await fetch(`${apiBase}/api/v0/models`);
  if (!res.ok) throw new Error(`LM Studio API error: ${res.status}`);
  const data = await res.json();
  return data.data.filter((m) => m.state === "loaded" && (m.type === "llm" || m.type === "vlm"));
}

function makeModel(modelId) {
  const provider = createOpenAICompatible({
    name:    "lmstudio",
    apiKey:  "lm-studio",
    baseURL: process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1",
  });
  return provider(modelId);
}

// ── Suite loading ─────────────────────────────────────────────────────────────

function loadSuites() {
  if (suiteArg) {
    return [JSON.parse(readFileSync(resolve(suiteArg), "utf-8"))];
  }
  const evalsDir = join(__dirname, "evals");
  if (!existsSync(evalsDir)) return [];
  return readdirSync(evalsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(evalsDir, f), "utf-8")));
}

// ── Tool subset for a case ────────────────────────────────────────────────────

function buildToolSubset(toolNames) {
  if (!toolNames || toolNames.length === 0) return ALL_TOOLS;
  return Object.fromEntries(
    toolNames.filter((n) => ALL_TOOLS[n]).map((n) => [n, ALL_TOOLS[n]])
  );
}

// ── Case runner ───────────────────────────────────────────────────────────────

async function runCase(evalCase, suite, model) {
  const system    = evalCase.systemPrompt ?? suite.systemPrompt ?? "You are a helpful personal assistant.";
  const evalTools = buildToolSubset(evalCase.tools);

  const t0 = Date.now();
  const result = await generateText({
    model,
    system,
    messages:    evalCase.messages,
    tools:       evalTools,
    maxSteps:    1,
    toolChoice:  "auto",
  });
  const elapsed = Date.now() - t0;
  const tokens  = (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0);
  const calledTools = result.toolCalls?.map((tc) => tc.toolName) ?? [];

  return { calledTools, elapsed, tokens };
}

// ── Assertion ─────────────────────────────────────────────────────────────────

function evaluate(expect, calledTools) {
  if (expect.noToolCall) {
    return calledTools.length === 0
      ? { pass: true }
      : { pass: false, reason: `expected no tool call, got: ${calledTools.join(", ")}` };
  }
  if (expect.toolCalls) {
    const missing = expect.toolCalls.filter((t) => !calledTools.includes(t));
    return missing.length === 0
      ? { pass: true }
      : { pass: false, reason: `expected [${expect.toolCalls.join(", ")}], got: ${calledTools.join(", ") || "(none)"}` };
  }
  if (expect.anyOf) {
    return expect.anyOf.some((t) => calledTools.includes(t))
      ? { pass: true }
      : { pass: false, reason: `expected any of [${expect.anyOf.join(", ")}], got: ${calledTools.join(", ") || "(none)"}` };
  }
  return { pass: false, reason: "unknown expect format" };
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const C = {
  pass:  "\x1b[32mPASS\x1b[0m",
  fail:  "\x1b[31mFAIL\x1b[0m",
  bold:  (s) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s) => `\x1b[2m${s}\x1b[0m`,
  cyan:  (s) => `\x1b[36m${s}\x1b[0m`,
  reset: "\x1b[0m",
};

function pad(s, n) { return String(s).padEnd(n); }

// ── Suite runner ──────────────────────────────────────────────────────────────

async function runSuite(suite, model, modelId) {
  console.log(`\n  Model: ${C.bold(modelId)}`);
  if (!calendarLoaded) console.log(C.dim("  (calendar tools: stubs — Google creds not found)"));
  if (!gmailLoaded) console.log(C.dim("  (gmail tools: stubs — OAuth creds not found)"));
  console.log("  " + "─".repeat(72));

  const caseResults = [];
  let totalTokens = 0;
  let totalMs = 0;
  let passed = 0;

  for (const c of suite.cases) {
    let calledTools = [];
    let elapsed = 0;
    let tokens = 0;
    let err = null;

    try {
      ({ calledTools, elapsed, tokens } = await runCase(c, suite, model));
    } catch (e) {
      err = e;
    }

    const { pass, reason } = err
      ? { pass: false, reason: String(err.message ?? err) }
      : evaluate(c.expect, calledTools);

    if (pass) passed++;
    totalTokens += tokens;
    totalMs += elapsed;

    const toolStr = calledTools.length ? `tools=[${calledTools.join(",")}]` : "tools=[]";
    console.log(
      `  ${pass ? C.pass : C.fail}  ${pad(c.id, 40)} ${pad(toolStr, 28)} ${String(elapsed).padStart(5)}ms  ${tokens}tok`
    );
    if (!pass) {
      console.log(`       ${C.dim("reason:")} ${reason}`);
    }

    caseResults.push({ c, suite, pass, calledTools, elapsed, tokens });
  }

  const total = suite.cases.length;
  const avgMs = total > 0 ? Math.round(totalMs / total) : 0;
  console.log("  " + "─".repeat(72));
  console.log(
    `  Summary: ${C.bold(`${passed}/${total}`)} passed  avg ${avgMs}ms  ${totalTokens} total tokens\n`
  );

  return { passed, total, caseResults };
}

// ── Fine-tuning export ────────────────────────────────────────────────────────

function toFineTuneRecord(evalCase, suite, calledTools) {
  const system = evalCase.systemPrompt ?? suite.systemPrompt ?? "You are a helpful personal assistant.";
  return {
    messages: [
      { role: "system", content: system },
      ...evalCase.messages,
      {
        role: "assistant",
        tool_calls: calledTools.map((name, i) => ({
          id:       `call_${i}`,
          type:     "function",
          function: { name, arguments: "{}" },
        })),
      },
    ],
  };
}

// ── Comparison table (--all-models) ──────────────────────────────────────────

function printComparisonTable(rows) {
  console.log("\n" + C.bold("  Model Comparison"));
  console.log("  " + "─".repeat(60));
  console.log(`  ${pad("Model", 40)} ${pad("Pass", 8)} Tokens`);
  console.log("  " + "─".repeat(60));
  for (const { modelId, passed, total, totalTokens } of rows) {
    const pct = total > 0 ? `${passed}/${total}` : "—";
    console.log(`  ${pad(modelId, 40)} ${pad(pct, 8)} ${totalTokens}`);
  }
  console.log("  " + "─".repeat(60));
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  const suites = loadSuites();
  if (suites.length === 0) {
    console.error("No eval suites found. Create a JSON file in evals/ or pass --suite <path>.");
    process.exit(1);
  }

  const loadedLLMs = await fetchLoadedLLMs();
  if (loadedLLMs.length === 0) {
    console.error("No loaded LLM found in LM Studio. Load a model first.");
    process.exit(1);
  }

  // Determine which models to run
  let targetModels;
  if (allModels) {
    targetModels = loadedLLMs;
  } else if (modelFilter) {
    const exact = loadedLLMs.find((m) => m.id === modelFilter);
    const sub   = loadedLLMs.find((m) => m.id.toLowerCase().includes(modelFilter.toLowerCase()));
    const found = exact ?? sub;
    if (!found) {
      console.error(`Model "${modelFilter}" not found. Loaded models: ${loadedLLMs.map((m) => m.id).join(", ")}`);
      process.exit(1);
    }
    targetModels = [found];
  } else {
    // Default: prefer MAIN_LLM env var, else first loaded
    const pref = process.env.MAIN_LLM;
    const found = pref
      ? (loadedLLMs.find((m) => m.id === pref) ?? loadedLLMs.find((m) => m.id.toLowerCase().includes(pref.toLowerCase())) ?? loadedLLMs[0])
      : loadedLLMs[0];
    targetModels = [found];
  }

  const fineTuneRecords = [];
  const comparisonRows  = [];

  for (const suite of suites) {
    console.log(`\n${C.bold(C.cyan(`Suite: ${suite.name}`))}`);

    for (const llmMeta of targetModels) {
      const model  = makeModel(llmMeta.id);
      const { passed, total, caseResults } = await runSuite(suite, model, llmMeta.id);

      const totalTokens = caseResults.reduce((s, r) => s + r.tokens, 0);
      comparisonRows.push({ modelId: llmMeta.id, passed, total, totalTokens });

      if (exportPath) {
        for (const { c, suite: s, pass, calledTools } of caseResults) {
          if (pass && calledTools.length > 0) {
            fineTuneRecords.push(toFineTuneRecord(c, s, calledTools));
          }
        }
      }
    }
  }

  if (allModels && comparisonRows.length > 1) {
    printComparisonTable(comparisonRows);
  }

  if (exportPath) {
    const jsonl = fineTuneRecords.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(resolve(exportPath), jsonl, "utf-8");
    console.log(`\nExported ${fineTuneRecords.length} fine-tuning records → ${exportPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
