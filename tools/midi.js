import { tool } from "ai";
import { z } from "zod";
import { readFile as fsReadFile } from "fs/promises";
import path from "path";
import pkg from "@tonejs/midi";
const { Midi } = pkg;
import { STRING_MIDI } from "./guitarTheory.js";

const MAX_FRET = 19;

function loadMidi(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  return fsReadFile(resolved).then((buf) => new Midi(buf));
}

function assignStringFret(midiPitch, warnings) {
  if (midiPitch < 40) {
    warnings.push(`Note MIDI ${midiPitch} is below lowest guitar note (E2=40) — skipped`);
    return null;
  }
  if (midiPitch > 83) {
    warnings.push(`Note MIDI ${midiPitch} is above fret ${MAX_FRET} on string 1 — clamped to 1:${MAX_FRET}`);
    return { string: 1, fret: MAX_FRET };
  }
  let best = null;
  for (let s = 1; s <= 6; s++) {
    const fret = midiPitch - STRING_MIDI[s];
    if (fret >= 0 && fret <= MAX_FRET) {
      // prefer higher fret on thicker string (higher string number) for playability
      if (best === null || fret < best.fret || (fret === best.fret && s > best.string)) {
        best = { string: s, fret };
      }
    }
  }
  return best;
}

function quantizeDuration(durationSec, bpm) {
  const quarter = 60 / bpm;
  const candidates = [
    { beats: 0.125, alphaTexDuration: "32", abcMultiplier: "/4" },
    { beats: 0.25,  alphaTexDuration: "16", abcMultiplier: "/2" },
    { beats: 0.5,   alphaTexDuration: "8",  abcMultiplier: "1" },
    { beats: 0.75,  alphaTexDuration: "8.", abcMultiplier: "3" },
    { beats: 1.0,   alphaTexDuration: "4",  abcMultiplier: "2" },
    { beats: 1.5,   alphaTexDuration: "4.", abcMultiplier: "3" },
    { beats: 2.0,   alphaTexDuration: "2",  abcMultiplier: "4" },
    { beats: 3.0,   alphaTexDuration: "2.", abcMultiplier: "6" },
    { beats: 4.0,   alphaTexDuration: "1",  abcMultiplier: "8" },
  ];
  const durationBeats = durationSec / quarter;
  let nearest = candidates[0];
  let minDiff = Math.abs(durationBeats - candidates[0].beats);
  for (const c of candidates) {
    const diff = Math.abs(durationBeats - c.beats);
    if (diff < minDiff) {
      minDiff = diff;
      nearest = c;
    }
  }
  return { alphaTexDuration: nearest.alphaTexDuration, abcMultiplier: nearest.abcMultiplier };
}

function groupNotesByTime(notes) {
  const TOLERANCE = 0.03; // 30ms
  const groups = [];
  for (const note of notes) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(note.time - last.time) <= TOLERANCE) {
      last.notes.push(note);
    } else {
      groups.push({ time: note.time, notes: [note] });
    }
  }
  return groups;
}

function notesToAlphaTex(notes, bpm, timeSig, warnings) {
  const [numerator, denominator] = timeSig;
  const quarter = 60 / bpm;
  const barDuration = numerator * quarter * (4 / denominator);
  const groups = groupNotesByTime(notes);

  const tokens = [];
  let elapsed = 0;
  let barElapsed = 0;

  for (const group of groups) {
    // Insert rest for gap
    const gap = group.time - elapsed;
    if (gap > 0.03) {
      const { alphaTexDuration } = quantizeDuration(gap, bpm);
      tokens.push(`r:${alphaTexDuration}`);
      barElapsed += gap;
      elapsed += gap;
      while (barElapsed >= barDuration - 0.03) {
        tokens.push("|");
        barElapsed -= barDuration;
      }
    }

    // Resolve string/fret for each note in group; handle conflicts
    const stringMap = new Map(); // string -> note
    for (const note of group.notes) {
      const pos = assignStringFret(note.midi, warnings);
      if (!pos) continue;
      if (stringMap.has(pos.string)) {
        const existing = stringMap.get(pos.string);
        if (note.velocity > existing.velocity) {
          warnings.push(`Two notes compete for string ${pos.string} — kept higher velocity note`);
          stringMap.set(pos.string, { ...note, fret: pos.fret });
        }
      } else {
        stringMap.set(pos.string, { ...note, fret: pos.fret });
      }
    }

    const positions = [...stringMap.values()];
    if (positions.length === 0) continue;

    const dur = quantizeDuration(group.notes[0].duration, bpm).alphaTexDuration;
    let token;
    if (positions.length === 1) {
      token = `${positions[0].fret}.${positions[0].string}:${dur}`;
    } else {
      const chord = positions.map((p) => `${p.fret}.${p.string}`).join(" ");
      token = `(${chord}):${dur}`;
    }
    tokens.push(token);

    const noteDur = group.notes[0].duration;
    barElapsed += noteDur;
    elapsed = group.time + noteDur;

    while (barElapsed >= barDuration - 0.03) {
      tokens.push("|");
      barElapsed -= barDuration;
    }
  }

  return tokens.join(" ");
}

const PITCH_CLASSES = ["C", "^C", "D", "^D", "E", "F", "^F", "G", "^G", "A", "^A", "B"];
const FLAT_PITCH_CLASSES = ["C", "_D", "D", "_E", "E", "F", "_G", "G", "_A", "A", "_B", "B"];
const FLAT_KEYS = new Set(["F", "Bb", "Eb", "Ab", "Db", "Gb", "d", "g", "c", "f", "bb", "eb"]);

function midiToAbcPitch(midi, useFlats) {
  const pitchClass = midi % 12;
  const octaveFromMiddleC = Math.floor((midi - 60) / 12);
  const name = useFlats ? FLAT_PITCH_CLASSES[pitchClass] : PITCH_CLASSES[pitchClass];

  // octaveFromMiddleC=0 → uppercase C octave; 1 → lowercase; 2 → c'; -1 → C,; etc.
  let letter = name.replace(/[\^_]/, "");
  const accidental = name.replace(/[A-Ga-g]/, "");

  if (octaveFromMiddleC >= 1) {
    letter = letter.toLowerCase();
    const ticks = "'".repeat(octaveFromMiddleC - 1);
    return accidental + letter + ticks;
  } else {
    const commas = ",".repeat(-octaveFromMiddleC);
    return accidental + letter + commas;
  }
}

function notesToAbc(notes, bpm, header, title, warnings) {
  const timeSig = header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const [numerator, denominator] = timeSig;
  const keyData = header.keySignatures[0];
  const keyStr = keyData ? `${keyData.key} ${keyData.scale}` : "C major";
  const useFlats = FLAT_KEYS.has(keyData?.key ?? "C");

  const abcHeader = `X:1\nT:${title}\nM:${numerator}/${denominator}\nL:1/8\nQ:${Math.round(bpm)}\nK:${keyStr}\n`;

  const quarter = 60 / bpm;
  const barDuration = numerator * quarter * (4 / denominator);
  const groups = groupNotesByTime(notes);

  let body = "";
  let elapsed = 0;
  let barElapsed = 0;
  let barCount = 0;

  for (const group of groups) {
    // Melody: highest pitch
    const melody = group.notes.reduce((a, b) => (a.midi > b.midi ? a : b));

    // Rest for gap
    const gap = group.time - elapsed;
    if (gap > 0.03) {
      const { abcMultiplier } = quantizeDuration(gap, bpm);
      const mult = abcMultiplier === "1" ? "" : abcMultiplier;
      body += `z${mult} `;
      barElapsed += gap;
      elapsed += gap;
      while (barElapsed >= barDuration - 0.03) {
        body += "| ";
        barCount++;
        if (barCount % 4 === 0) body += "\n";
        barElapsed -= barDuration;
      }
    }

    const pitch = midiToAbcPitch(melody.midi, useFlats);
    const { abcMultiplier } = quantizeDuration(melody.duration, bpm);
    const mult = abcMultiplier === "1" ? "" : abcMultiplier;
    body += `${pitch}${mult} `;

    barElapsed += melody.duration;
    elapsed = group.time + melody.duration;

    while (barElapsed >= barDuration - 0.03) {
      body += "| ";
      barCount++;
      if (barCount % 4 === 0) body += "\n";
      barElapsed -= barDuration;
    }
  }

  body += "|]";
  return abcHeader + body;
}

// ─── Tool: listMidiTracks ───────────────────────────────────────────────────

export const listMidiTracks = tool({
  description:
    "Read a .mid file and return its tracks with instrument names, note counts, pitch ranges, and guitarPlayable flags. Use this first to inspect a MIDI file before extracting a track.",
  inputSchema: z.object({
    path: z.string().describe("Path to the .mid file (absolute or relative to cwd)"),
  }),
  execute: async ({ path: filePath }) => {
    let midi;
    try {
      midi = await loadMidi(filePath);
    } catch (err) {
      return { error: `Could not read MIDI file: ${err.message}` };
    }

    try {
      const bpm = midi.header.tempos[0]?.bpm ?? 120;
      const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
      const ks = midi.header.keySignatures[0];
      const keySignature = ks ? `${ks.key} ${ks.scale}` : "C major";
      const durationSeconds = midi.duration;

      const tracks = midi.tracks.map((t, i) => {
        const noteCount = t.notes.length;
        const pitches = t.notes.map((n) => n.midi);
        const min = pitches.length ? Math.min(...pitches) : null;
        const max = pitches.length ? Math.max(...pitches) : null;
        const guitarPlayable =
          noteCount > 0 &&
          pitches.filter((p) => p >= 40 && p <= 83).length / noteCount >= 0.8;

        return {
          index: i,
          name: t.name || `Track ${i}`,
          instrument: t.instrument.name,
          noteCount,
          pitchRange: noteCount ? { min, max } : null,
          isPercussion: t.instrument.percussion,
          guitarPlayable,
        };
      });

      return {
        header: {
          bpm: Math.round(bpm * 10) / 10,
          timeSignature: `${ts[0]}/${ts[1]}`,
          keySignature,
          durationSeconds: Math.round(durationSeconds * 10) / 10,
        },
        tracks,
      };
    } catch (err) {
      return { error: `Failed to parse MIDI: ${err.message}` };
    }
  },
});

// ─── Tool: extractMidiTrack ─────────────────────────────────────────────────

export const extractMidiTrack = tool({
  description:
    "Extract a specific track from a .mid file and convert it to guitar tab (alphaTex) and/or sheet music (ABC notation). Use listMidiTracks first to identify the track index.",
  inputSchema: z.object({
    path: z.string().describe("Path to the .mid file"),
    trackIndex: z.number().int().min(0).describe("Zero-based track index from listMidiTracks"),
    format: z
      .enum(["tab", "score", "both"])
      .describe("Output format: tab (alphaTex), score (ABC), or both"),
  }),
  execute: async ({ path: filePath, trackIndex, format }) => {
    let midi;
    try {
      midi = await loadMidi(filePath);
    } catch (err) {
      return { error: `Could not read MIDI file: ${err.message}` };
    }

    if (trackIndex >= midi.tracks.length) {
      return { error: `Track index ${trackIndex} out of range (file has ${midi.tracks.length} tracks)` };
    }

    const track = midi.tracks[trackIndex];

    if (track.instrument.percussion) {
      return { error: `Track ${trackIndex} is a percussion track — cannot convert to guitar notation` };
    }

    const warnings = [];
    const notes = [...track.notes].sort((a, b) => a.time - b.time);

    if (notes.length === 0) {
      warnings.push("Track has no notes");
      return {
        trackName: track.name || `Track ${trackIndex}`,
        instrument: track.instrument.name,
        bpm: Math.round((midi.header.tempos[0]?.bpm ?? 120) * 10) / 10,
        noteCount: 0,
        alphaTex: format !== "score" ? "r:1" : null,
        abc: null,
        warnings,
      };
    }

    const bpm = midi.header.tempos[0]?.bpm ?? 120;
    if (midi.header.tempos.length > 1) {
      warnings.push(`File has ${midi.header.tempos.length} tempo changes — using first tempo (${Math.round(bpm)} BPM)`);
    }

    const timeSig = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
    const title = track.name || `Track ${trackIndex}`;

    let alphaTex = null;
    let abc = null;

    if (format === "tab" || format === "both") {
      alphaTex = notesToAlphaTex(notes, bpm, timeSig, warnings);
    }

    if (format === "score" || format === "both") {
      abc = notesToAbc(notes, bpm, midi.header, title, warnings);
    }

    return {
      trackName: title,
      instrument: track.instrument.name,
      bpm: Math.round(bpm * 10) / 10,
      noteCount: notes.length,
      alphaTex,
      abc,
      warnings,
    };
  },
});
