// Pure ES module — no framework imports
// Deterministic guitar theory engine: scales, chords, and fretboard mapping

export const CHROMATIC = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

export const ENHARMONIC = {
  'Db':'C#','Eb':'D#','Fb':'E','Gb':'F#','Ab':'G#','Bb':'A#','Cb':'B'
};

// MIDI pitch of open strings. Index = AlphaTex string number (str1=high e, str6=low E)
export const STRING_MIDI = { 1:64, 2:59, 3:55, 4:50, 5:45, 6:40 };

export function noteIndex(name) {
  const c = ENHARMONIC[name] ?? name;
  const i = CHROMATIC.indexOf(c);
  if (i === -1) throw new Error(`Unknown note: "${name}"`);
  return i;
}

// Intervals (semitones from root)
export const SCALE_FORMULAS = {
  major:            [0,2,4,5,7,9,11],
  natural_minor:    [0,2,3,5,7,8,10],
  harmonic_minor:   [0,2,3,5,7,8,11],
  melodic_minor:    [0,2,3,5,7,9,11],
  pentatonic_major: [0,2,4,7,9],
  pentatonic_minor: [0,3,5,7,10],
  blues:            [0,3,5,6,7,10],
  dorian:           [0,2,3,5,7,9,10],
  phrygian:         [0,1,3,5,7,8,10],
  lydian:           [0,2,4,6,7,9,11],
  mixolydian:       [0,2,4,5,7,9,10],
  locrian:          [0,1,3,5,6,8,10],
  whole_tone:       [0,2,4,6,8,10],
  diminished:       [0,2,3,5,6,8,9,11],
};

export const CHORD_FORMULAS = {
  major:[0,4,7], minor:[0,3,7], dim:[0,3,6], aug:[0,4,8],
  sus2:[0,2,7],  sus4:[0,5,7],
  dom7:[0,4,7,10], maj7:[0,4,7,11], min7:[0,3,7,10],
  dim7:[0,3,6,9],  half_dim7:[0,3,6,10], mmaj7:[0,3,7,11],
  dom9:[0,4,7,10,14], maj9:[0,4,7,11,14], min9:[0,3,7,10,14],
  add9:[0,4,7,14],    madd9:[0,3,7,14],
};

// Open chord voicings: [str6, str5, str4, str3, str2, str1] absolute frets. null = muted
export const OPEN_CHORDS = {
  C_major:  [null,3,2,0,1,0],
  D_major:  [null,null,0,2,3,2],
  E_major:  [0,2,2,1,0,0],
  G_major:  [3,2,0,0,0,3],
  A_major:  [null,0,2,2,2,0],
  A_minor:  [null,0,2,2,1,0],
  E_minor:  [0,2,2,0,0,0],
  D_minor:  [null,null,0,2,3,1],
  E_dom7:   [0,2,0,1,0,0],
  A_dom7:   [null,0,2,0,2,0],
  G_dom7:   [3,2,0,0,0,1],
  D_dom7:   [null,null,0,2,1,2],
  C_maj7:   [null,3,2,0,0,0],
  E_min7:   [0,2,0,0,0,0],
  A_min7:   [null,0,2,0,1,0],
};

// CAGED barre shapes — offsets from the barre fret. null = muted.
// rootStr: which string the root falls on.
export const BARRE_SHAPES = {
  E_major: { rootStr:6, offsets:[0,2,2,1,0,0] },
  E_minor: { rootStr:6, offsets:[0,2,2,0,0,0] },
  E_dom7:  { rootStr:6, offsets:[0,2,0,1,0,0] },
  E_maj7:  { rootStr:6, offsets:[0,2,1,1,0,0] },
  E_min7:  { rootStr:6, offsets:[0,2,0,0,0,0] },
  A_major: { rootStr:5, offsets:[null,0,2,2,2,0] },
  A_minor: { rootStr:5, offsets:[null,0,2,2,1,0] },
  A_dom7:  { rootStr:5, offsets:[null,0,2,0,2,0] },
  A_maj7:  { rootStr:5, offsets:[null,0,2,1,2,0] },
  A_min7:  { rootStr:5, offsets:[null,0,2,0,1,0] },
};

// Movable extended shapes (root on str5).
// Voicing: x-root-5th-b7-3rd-9th (offsets validated by MIDI arithmetic).
// str1 offset=7 gives the 9th (only reachable as (5th+7)%12=2=9th interval from root).
export const EXTENDED_SHAPES = {
  dom9: { rootStr:5, offsets:[null,0,2,0,2,7] },
  maj9: { rootStr:5, offsets:[null,0,2,1,2,7] },
  min9: { rootStr:5, offsets:[null,0,2,0,1,7] },
};

// ─── Scale algorithm ───────────────────────────────────────────────────────────

/**
 * Build a one-octave scale fingering pattern (up + down) as AlphaTex.
 *
 * @param {string} root       - Root note name e.g. "G", "Bb", "C#"
 * @param {string} scaleType  - Key in SCALE_FORMULAS
 * @param {string|number} position
 *   "open"  → window frets 0-4 (includes open strings)
 *   "root"  → window starts on the root note's fret on str6
 *   number  → window starts at that fret
 * @returns {{ alphaTex: string, notes: string[], description: string }}
 */
export function buildScalePattern(root, scaleType, position) {
  const rootPC = noteIndex(root);
  const formula = SCALE_FORMULAS[scaleType];
  if (!formula) throw new Error(`Unknown scale type: "${scaleType}"`);

  const scalePCs = new Set(formula.map(i => (rootPC + i) % 12));

  let startFret;
  const spanFrets = 4;

  if (position === 'open') {
    startFret = 0;
  } else if (position === 'root') {
    // Find fret on str6 (low E, open PC=4) that plays the root note
    const openPC6 = STRING_MIDI[6] % 12;
    startFret = (rootPC - openPC6 + 12) % 12;
  } else {
    startFret = Number(position);
  }

  // Collect ALL valid notes per string in the window (builds a proper box pattern).
  // Deduplicate by MIDI so each pitch appears once (prefer lower string when tied).
  const candidates = [];
  const seenMidi = new Set();
  for (let strNum = 6; strNum >= 1; strNum--) {
    for (let fret = startFret; fret <= startFret + spanFrets; fret++) {
      const midi = STRING_MIDI[strNum] + fret;
      const pc = midi % 12;
      if (scalePCs.has(pc) && !seenMidi.has(midi)) {
        candidates.push({ strNum, fret, midi });
        seenMidi.add(midi);
      }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `No scale notes found for ${root} ${scaleType} at position ${position} — ` +
      `try a different position or "open"`
    );
  }

  // Sort ascending by MIDI pitch
  const ascending = [...candidates].sort((a, b) => a.midi - b.midi);
  // Descend from second-highest back to lowest (avoids repeating the top note)
  const descending = [...ascending].reverse().slice(1);

  const allNotes = [...ascending, ...descending];
  const alphaTex = ':8 ' + allNotes.map(n => `${n.fret}.${n.strNum}`).join(' ');

  const noteNames = [...new Set(ascending.map(n => CHROMATIC[n.midi % 12]))];

  const posLabel = position === 'open' ? 'open position'
    : position === 'root' ? 'root position'
    : `position ${position}`;
  const description =
    `${root} ${scaleType.replace(/_/g, ' ')} scale — ${posLabel}`;

  return { alphaTex, notes: noteNames, description };
}

// ─── Chord algorithm ──────────────────────────────────────────────────────────

/**
 * Build a guitar chord voicing as AlphaTex.
 *
 * @param {string} root       - Root note name e.g. "G", "Bb", "F#"
 * @param {string} chordType  - Key in CHORD_FORMULAS
 * @param {string} voicing    - "open" | "barre-E" | "barre-A" | "auto"
 * @returns {{ alphaTex: string, notes: string[], description: string }}
 */
export function buildChordVoicing(root, chordType, voicing) {
  if (!CHORD_FORMULAS[chordType]) throw new Error(`Unknown chord type: "${chordType}"`);

  const rootPC = noteIndex(root);
  let absoluteFrets = null;
  let shapeDesc = '';

  // ── Step 1: open chord lookup (for "open" and "auto") ──────────────────────
  if (voicing === 'open' || voicing === 'auto') {
    const normalizedRoot = ENHARMONIC[root] ?? root;
    const openFrets =
      OPEN_CHORDS[`${normalizedRoot}_${chordType}`] ??
      OPEN_CHORDS[`${root}_${chordType}`];

    if (openFrets) {
      absoluteFrets = openFrets;
      shapeDesc = 'open';
    } else if (voicing === 'open') {
      throw new Error(`No open voicing available for ${root} ${chordType}`);
    }
  }

  // ── Step 2: barre / extended shapes ────────────────────────────────────────
  if (!absoluteFrets) {
    if (voicing === 'barre-E') {
      absoluteFrets = _applyBarreShape(`E_${chordType}`, rootPC);
      shapeDesc = `E-shape barre`;
    } else if (voicing === 'barre-A') {
      absoluteFrets = _applyBarreShape(`A_${chordType}`, rootPC);
      shapeDesc = `A-shape barre`;
    } else {
      // auto — try extended shapes first, then CAGED barre
      const extShape = EXTENDED_SHAPES[chordType];
      if (extShape) {
        const result = _applyShape(extShape, rootPC);
        absoluteFrets = result.frets;
        const sType = extShape.rootStr === 6 ? 'E-shape' : 'A-shape';
        shapeDesc = `${sType} extended at fret ${result.barreFret}`;
      } else {
        // Prefer E-shape for triads; A-shape for 7th/extended types
        const basicTypes = ['major','minor','dim','aug','sus2','sus4'];
        let shapeName;
        if (basicTypes.includes(chordType)) {
          shapeName = BARRE_SHAPES[`E_${chordType}`] ? `E_${chordType}` : `A_${chordType}`;
        } else {
          shapeName = BARRE_SHAPES[`A_${chordType}`] ? `A_${chordType}` : `E_${chordType}`;
        }
        const shape = BARRE_SHAPES[shapeName];
        if (!shape) {
          throw new Error(
            `No voicing shape available for ${root} ${chordType}. ` +
            `Supported chord types for barre: major, minor, dom7, maj7, min7, dom9, maj9, min9.`
          );
        }
        const result = _applyShape(shape, rootPC);
        absoluteFrets = result.frets;
        const sType = shapeName.startsWith('E') ? 'E-shape' : 'A-shape';
        shapeDesc = `${sType} barre at fret ${result.barreFret}`;
      }
    }
  }

  // ── Step 3: convert to AlphaTex and note names ─────────────────────────────
  const parts = [];
  const notes = [];
  for (let i = 0; i < 6; i++) {
    const strNum = 6 - i;
    const fret = absoluteFrets[i];
    if (fret !== null && fret !== undefined) {
      parts.push(`${fret}.${strNum}`);
      const pc = (STRING_MIDI[strNum] + fret) % 12;
      const name = CHROMATIC[pc];
      if (!notes.includes(name)) notes.push(name);
    }
  }

  const alphaTex = '(' + parts.join(' ') + ')';
  const chordLabel = `${root} ${chordType.replace(/_/g, ' ')}`;
  const description = `${chordLabel} — ${shapeDesc}`;

  return { alphaTex, notes, description };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _applyShape(shape, rootPC) {
  const { rootStr, offsets } = shape;
  const openPC = STRING_MIDI[rootStr] % 12;
  let barreFret = (rootPC - openPC + 12) % 12;
  if (barreFret === 0) barreFret = 12; // prefer closed position, not open
  const frets = offsets.map(o => (o === null || o === undefined) ? null : barreFret + o);
  return { frets, barreFret };
}

function _applyBarreShape(shapeName, rootPC) {
  const shape = BARRE_SHAPES[shapeName];
  if (!shape) throw new Error(`No barre shape defined: "${shapeName}"`);
  return _applyShape(shape, rootPC).frets;
}
