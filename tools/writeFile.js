import { tool } from "ai";
import { z } from "zod";
import { writeFile as fsWriteFile } from "fs/promises";

export const writeFile = tool({
  description:
    "Write content to a file at the given path. Creates the file if it doesn't exist, overwrites if it does.",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }) => {
    try {
      await fsWriteFile(path, content, "utf-8");
      return `File written: ${path}`;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },
});
