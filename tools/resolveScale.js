import { tool } from "ai";
import { z } from "zod";
import { buildScalePattern } from "./guitarTheory.js";

export const resolveScale = tool({
  description:
    "Compute a guitar scale fingering pattern and return AlphaTex. " +
    "Call this BEFORE renderTab for any scale or fret-position request. " +
    "Do NOT compute fret positions yourself.",
  inputSchema: z.object({
    root: z.string().describe('Root note, e.g. "G", "Bb", "C#"'),
    scaleType: z.enum([
      "major","natural_minor","harmonic_minor","melodic_minor",
      "pentatonic_major","pentatonic_minor","blues",
      "dorian","phrygian","lydian","mixolydian","locrian",
      "whole_tone","diminished",
    ]),
    position: z.union([
      z.literal("open"),
      z.literal("root"),
      z.number().int().min(0).max(12),
    ]).default("open").describe(
      '"open" = open strings included (beginner-friendly). ' +
      '"root" = starts on the root note on the low E string. ' +
      'Number = explicit starting fret.'
    ),
  }),
  execute: async ({ root, scaleType, position }) => {
    try {
      return buildScalePattern(root, scaleType, position);
    } catch (err) {
      return { error: err.message };
    }
  },
});
