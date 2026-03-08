import { tool } from "ai";
import { z } from "zod";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_FILE = join(__dirname, "..", "tasks.json");

function loadTasks() {
  try {
    const raw = readFileSync(TASKS_FILE, "utf8");
    return JSON.parse(raw).tasks ?? [];
  } catch {
    return [];
  }
}

function saveTasks(tasks) {
  writeFileSync(TASKS_FILE, JSON.stringify({ tasks }, null, 2), "utf8");
}

const ROLES = ["work", "personal", "health", "family", "finance", "learning", "projects", "other"];
const PRIORITIES = ["high", "medium", "low"];
const STATUSES = ["open", "in-progress", "blocked", "done"];

function findById(tasks, id) {
  return tasks.find((t) => t.id.startsWith(id) || t.id === id);
}

export const createTask = tool({
  description: "Create a new task and persist it to the task store.",
  inputSchema: z.object({
    title: z.string().describe("Short description of the task"),
    role: z.enum(ROLES).describe("Life role this task belongs to"),
    priority: z.enum(PRIORITIES).default("medium").describe("Task priority"),
    notes: z.string().optional().describe("Additional context or notes"),
    dueDate: z.string().optional().describe("Due date in YYYY-MM-DD format"),
    suggestedAgent: z.string().optional().describe("Archetype id of agent best suited to execute this task"),
  }),
  execute: async ({ title, role, priority, notes, dueDate, suggestedAgent }) => {
    const tasks = loadTasks();
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const task = {
      id,
      title,
      role,
      priority,
      status: "open",
      notes: notes ?? null,
      dueDate: dueDate ?? null,
      suggestedAgent: suggestedAgent ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };
    tasks.push(task);
    saveTasks(tasks);
    return `Task created: ${id.slice(0, 8)} — ${title} [${role}] [${priority}]`;
  },
});

export const listTasks = tool({
  description: "List tasks with optional filtering by role, status, or priority.",
  inputSchema: z.object({
    role: z.enum(ROLES).optional().describe("Filter by life role"),
    status: z.enum(STATUSES).optional().describe("Filter by status"),
    priority: z.enum(PRIORITIES).optional().describe("Filter by priority"),
    includeCompleted: z.boolean().default(false).describe("Include done tasks in results"),
  }),
  execute: async ({ role, status, priority, includeCompleted }) => {
    let tasks = loadTasks();

    if (!includeCompleted) tasks = tasks.filter((t) => t.status !== "done");
    if (role) tasks = tasks.filter((t) => t.role === role);
    if (status) tasks = tasks.filter((t) => t.status === status);
    if (priority) tasks = tasks.filter((t) => t.priority === priority);

    if (tasks.length === 0) return "No tasks found matching the given criteria.";

    // Group by role
    const grouped = {};
    for (const t of tasks) {
      if (!grouped[t.role]) grouped[t.role] = [];
      grouped[t.role].push(t);
    }

    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const lines = [];
    for (const [r, items] of Object.entries(grouped)) {
      lines.push(`\n### ${r.toUpperCase()}`);
      const sorted = items.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
      for (const t of sorted) {
        const due = t.dueDate ? ` due:${t.dueDate}` : "";
        const agent = t.suggestedAgent ? ` → ${t.suggestedAgent}` : "";
        lines.push(`  [${t.id.slice(0, 8)}] [${t.priority.toUpperCase()}] [${t.status}] ${t.title}${due}${agent}`);
      }
    }
    return lines.join("\n");
  },
});

export const updateTask = tool({
  description: "Update fields on an existing task by id (prefix match on first 8 chars).",
  inputSchema: z.object({
    id: z.string().describe("Task id or 8-char prefix"),
    title: z.string().optional(),
    role: z.enum(ROLES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(STATUSES).optional(),
    notes: z.string().optional(),
    dueDate: z.string().optional(),
    suggestedAgent: z.string().optional(),
  }),
  execute: async ({ id, ...patch }) => {
    const tasks = loadTasks();
    const task = findById(tasks, id);
    if (!task) return `Task not found: ${id}`;

    const now = new Date().toISOString();
    Object.assign(task, patch, { updatedAt: now });
    saveTasks(tasks);
    return `Updated [${task.id.slice(0, 8)}] ${task.title} — now: [${task.role}] [${task.priority}] [${task.status}]`;
  },
});

export const completeTask = tool({
  description: "Mark a task as done.",
  inputSchema: z.object({
    id: z.string().describe("Task id or 8-char prefix"),
    notes: z.string().optional().describe("Optional completion notes to append"),
  }),
  execute: async ({ id, notes }) => {
    const tasks = loadTasks();
    const task = findById(tasks, id);
    if (!task) return `Task not found: ${id}`;

    const now = new Date().toISOString();
    task.status = "done";
    task.completedAt = now;
    task.updatedAt = now;
    if (notes) task.notes = task.notes ? `${task.notes}\n${notes}` : notes;
    saveTasks(tasks);
    return `Completed: "${task.title}" ✓`;
  },
});

export const deleteTask = tool({
  description: "Permanently delete a task by id.",
  inputSchema: z.object({
    id: z.string().describe("Task id or 8-char prefix"),
  }),
  execute: async ({ id }) => {
    const tasks = loadTasks();
    const idx = tasks.findIndex((t) => t.id.startsWith(id) || t.id === id);
    if (idx === -1) return `Task not found: ${id}`;
    const [removed] = tasks.splice(idx, 1);
    saveTasks(tasks);
    return `Deleted: "${removed.title}"`;
  },
});
