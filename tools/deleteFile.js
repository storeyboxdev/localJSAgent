import { tool } from "ai";
import { z } from "zod";
import { unlink } from "fs/promises";

export const deleteFile = tool({
  description: "Delete the file at the given path.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    try {
      await unlink(path);
      return `File deleted: ${path}`;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },
});
