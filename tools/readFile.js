import { tool } from "ai";
import { z } from "zod";
import { readFile as fsReadFile } from "fs/promises";

export const readFile = tool({
  description: "Read the contents of a file at the given path.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    try {
      return await fsReadFile(path, "utf-8");
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },
});
