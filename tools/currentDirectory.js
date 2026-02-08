import { tool } from "ai";
import { z } from "zod";

export const currentDirectory = tool({
  description: "Returns the current working directory path.",
  inputSchema: z.object({}),
  execute: async () => {
    return process.cwd();
  },
});
