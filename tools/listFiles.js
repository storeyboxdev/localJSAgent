import { tool } from "ai";
import { z } from "zod";
import { readdir } from "fs/promises";

export const listFiles = tool({
  description:
    "List files and directories at the given path. Use '.' for the current directory.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries
        .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
        .join("\n");
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },
});
