// lib/agentStore.js — persistent agent instance & archetype management

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ARCHETYPES_DIR = join(ROOT, "archetypes");
const INSTANCES_DIR = join(ROOT, "agent-instances");

// Ensure agent-instances directory exists
if (!existsSync(INSTANCES_DIR)) mkdirSync(INSTANCES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Archetype helpers
// ---------------------------------------------------------------------------

/** @returns {object[]} All archetypes (id, name, description, icon, variables) */
export function loadArchetypes() {
  if (!existsSync(ARCHETYPES_DIR)) return [];
  return readdirSync(ARCHETYPES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(ARCHETYPES_DIR, f), "utf-8"));
      // Strip systemPrompt from list response (sent only when creating an instance)
      const { systemPrompt: _sp, ...rest } = raw;
      return rest;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {string} id */
export function getArchetype(id) {
  const file = join(ARCHETYPES_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

// ---------------------------------------------------------------------------
// Instance helpers
// ---------------------------------------------------------------------------

function instancePath(id) {
  return join(INSTANCES_DIR, `${id}.json`);
}

function readInstance(id) {
  const file = instancePath(id);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

function writeInstance(data) {
  writeFileSync(instancePath(data.id), JSON.stringify(data, null, 2), "utf-8");
  return data;
}

/** @returns {object[]} All instances (lightweight — no messages array) */
export function listAgents() {
  if (!existsSync(INSTANCES_DIR)) return [];
  return readdirSync(INSTANCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(INSTANCES_DIR, f), "utf-8"));
      const { messages: _m, ...rest } = raw;
      return rest;
    })
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/** @param {string} id — full instance including messages */
export function getAgent(id) {
  return readInstance(id);
}

/**
 * Resolve {{PLACEHOLDER}} variables in a system prompt template.
 * Always substitutes {{DATE}} with today's date.
 */
function resolveSystemPrompt(template, variables, archetype) {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  let p = template.replace(/\{\{DATE\}\}/g, today);
  for (const [key, def] of Object.entries(archetype.variables ?? {})) {
    p = p.replaceAll(`{{${key}}}`, variables?.[key] ?? def.default ?? "");
  }
  return p;
}

/**
 * Create a new agent instance from an archetype or from scratch.
 * @param {{ archetypeId?: string, name: string, variables?: object, systemPrompt?: string, tools?: string[], icon?: string }} opts
 */
export function createAgent({ archetypeId, name, variables = {}, systemPrompt, tools: customTools, icon }) {
  const id = randomUUID();
  const now = new Date().toISOString();

  if (archetypeId) {
    const archetype = getArchetype(archetypeId);
    if (!archetype) throw new Error(`Archetype not found: ${archetypeId}`);

    // Validate required variables
    for (const [key, def] of Object.entries(archetype.variables ?? {})) {
      if (def.required && !variables[key]) {
        throw new Error(`Missing required variable: ${key} (${def.label})`);
      }
    }

    const instance = {
      id,
      archetypeId,
      isCustom: false,
      name: name || archetype.defaultInstanceName,
      icon: icon ?? archetype.icon,
      resolvedSystemPrompt: resolveSystemPrompt(archetype.systemPrompt, variables, archetype),
      variables,
      tools: archetype.tools,
      messages: [],
      tokenCount: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    return writeInstance(instance);
  }

  // Custom (free-form) agent — systemPrompt provided directly
  if (!systemPrompt) throw new Error("systemPrompt required when archetypeId is not provided");
  const instance = {
    id,
    archetypeId: null,
    isCustom: true,
    name: name || "Custom Agent",
    icon: icon ?? "✨",
    resolvedSystemPrompt: systemPrompt,
    variables: {},
    tools: customTools ?? [],
    messages: [],
    tokenCount: 0,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  return writeInstance(instance);
}

/**
 * Update agent metadata (e.g., rename).
 * @param {string} id
 * @param {{ name?: string }} patch
 */
export function updateAgent(id, patch) {
  const instance = readInstance(id);
  if (!instance) throw new Error(`Agent not found: ${id}`);
  const updated = { ...instance, ...patch, updatedAt: new Date().toISOString() };
  return writeInstance(updated);
}

/**
 * Persist messages and token count after a chat round.
 * @param {string} id
 * @param {object[]} messages
 * @param {number|null} tokenCount
 */
export function saveAgentMessages(id, messages, tokenCount) {
  const instance = readInstance(id);
  if (!instance) throw new Error(`Agent not found: ${id}`);
  const updated = {
    ...instance,
    messages,
    tokenCount: tokenCount ?? instance.tokenCount,
    messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
    updatedAt: new Date().toISOString(),
  };
  return writeInstance(updated);
}

/** @param {string} id */
export function deleteAgent(id) {
  const file = instancePath(id);
  if (!existsSync(file)) throw new Error(`Agent not found: ${id}`);
  unlinkSync(file);
}
