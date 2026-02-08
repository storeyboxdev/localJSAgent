import { tool } from "ai";
import { z } from "zod";

export const dateTime = tool({
  description:
    "Returns the current date and time in a formatted string. Use this whenever using dates or times.",
  inputSchema: z.object({}),
  execute: async () => {
    return new Date().toISOString();
  },
});
