import { tool } from "ai";
import { z } from "zod";
import { buildChordVoicing } from "./guitarTheory.js";

export const resolveChord = tool({
  description:
    "Compute a guitar chord voicing and return AlphaTex. " +
    "Call this BEFORE renderTab for any chord shape request. " +
    "Do NOT compute fret positions yourself.",
  inputSchema: z.object({
    root: z.string().describe('Root note, e.g. "G", "Bb", "F#"'),
    chordType: z.enum([
      "major","minor","dim","aug","sus2","sus4",
      "dom7","maj7","min7","dim7","half_dim7","mmaj7",
      "dom9","maj9","min9","add9","madd9",
    ]),
    voicing: z.enum(["open","barre-E","barre-A","auto"]).default("auto").describe(
      '"auto" = use open voicing if available, otherwise barre. ' +
      '"barre-E" / "barre-A" = force E-shape or A-shape barre chord.'
    ),
  }),
  execute: async ({ root, chordType, voicing }) => {
    try {
      return buildChordVoicing(root, chordType, voicing);
    } catch (err) {
      return { error: err.message };
    }
  },
});
