import { tool } from "ai";
import { z } from "zod";

export const renderScore = tool({
  description:
    "Render standard musical notation (treble clef, staff, note heads) using ABC notation. " +
    "Use this for melodies, scales, sight-reading exercises, or any music theory concept " +
    "best shown in standard notation rather than guitar tab. " +
    "After calling this tool, output the same ABC notation in your response inside a ```abc code block.",
  inputSchema: z.object({
    abc: z.string().describe("Musical notation in ABC format"),
    title: z.string().optional().describe("Title for the piece or exercise"),
  }),
  execute: async ({ abc, title }) => ({ abc, title: title ?? null }),
});
