import { tool } from "ai";
import { z } from "zod";

export const renderTab = tool({
  description:
    "Render guitar tablature as a visual music score using proper notation. " +
    "Use this for full songs, exercises, or anything where visual notation matters more than quick ASCII. " +
    "After calling this tool, do NOT write an alphatab code block in your response — the system renders the tab automatically. Just continue with your text explanation.",
  inputSchema: z.object({
    alphaTex: z.string().describe("Guitar tablature in alphaTex format"),
    title: z.string().optional().describe("Title (song name or exercise name)"),
  }),
  execute: async ({ alphaTex, title }) => ({ alphaTex, title: title ?? null }),
});
