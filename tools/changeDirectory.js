import { tool } from "ai";
import { z } from "zod";

export const changeDirectory = tool({
  description: "Change the current working directory to the given path.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    try {
      process.chdir(path);
      return `Changed directory to: ${process.cwd()}`;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  },
});
