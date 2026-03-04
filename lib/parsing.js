// lib/parsing.js — file content extraction
// Text/code files: native UTF-8; binary formats (.pdf, .docx, .html): docling-serve

const DOCLING_SERVE_URL = process.env.DOCLING_SERVE_URL ?? "http://localhost:5001";

const DIRECT_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".js", ".ts", ".jsx", ".tsx", ".py", ".json", ".csv",
  ".yaml", ".yml", ".toml", ".xml", ".sh", ".bash", ".c", ".cpp", ".h",
  ".java", ".go", ".rs", ".rb", ".php",
  ".abc", ".tab", ".ly",   // music notation (plain text)
]);

const DOCLING_EXTENSIONS = new Set([".pdf", ".docx", ".html", ".htm"]);

const CHORDPRO_EXTENSIONS = new Set([".cho", ".chordpro"]);
const MUSICXML_EXTENSIONS = new Set([".musicxml"]);

const TERMINAL_TASK_STATUSES = new Set(["success", "failure", "partial_success", "skipped"]);
const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 120; // 3 minutes max

function getExtension(filename) {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function extractTextFromDoclingResponse(json) {
  if (typeof json.document?.md_content === "string") return json.document.md_content;
  if (typeof json.md_content === "string") return json.md_content;
  if (typeof json.content === "string") return json.content;
  if (typeof json.text === "string") return json.text;
  if (typeof json.markdown === "string") return json.markdown;
  if (typeof json.result === "string") return json.result;
  throw new Error("Unexpected docling-serve response: " + JSON.stringify(json).slice(0, 200));
}

async function convertViaDocling(buffer, filename) {
  const formData = new FormData();
  formData.append("files", new Blob([buffer]), filename);

  // Submit async conversion task
  const submitRes = await fetch(`${DOCLING_SERVE_URL}/v1/convert/file/async`, {
    method: "POST",
    body: formData,
  });
  if (!submitRes.ok) {
    const errorText = await submitRes.text().catch(() => "unknown error");
    throw new Error(`docling-serve submit error (${submitRes.status}): ${errorText}`);
  }
  const { task_id } = await submitRes.json();

  // Poll until terminal status
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await fetch(`${DOCLING_SERVE_URL}/v1/status/poll/${task_id}`);
    if (!pollRes.ok) {
      const errorText = await pollRes.text().catch(() => "unknown error");
      throw new Error(`docling-serve poll error (${pollRes.status}): ${errorText}`);
    }
    const { task_status } = await pollRes.json();

    if (!TERMINAL_TASK_STATUSES.has(task_status)) continue;

    if (task_status === "failure") {
      throw new Error(`docling-serve conversion failed for "${filename}"`);
    }

    // Fetch the result
    const resultRes = await fetch(`${DOCLING_SERVE_URL}/v1/result/${task_id}`);
    if (!resultRes.ok) {
      const errorText = await resultRes.text().catch(() => "unknown error");
      throw new Error(`docling-serve result error (${resultRes.status}): ${errorText}`);
    }
    const json = await resultRes.json();
    return extractTextFromDoclingResponse(json);
  }

  throw new Error(
    `docling-serve timed out after ${(POLL_MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000}s for "${filename}"`
  );
}

function parseChordPro(text) {
  const lines = text.split("\n");
  const meta = {};
  const chords = new Set();
  const body = [];

  for (const line of lines) {
    const dirMatch = line.match(/^\{([^:}]+)(?::(.+))?\}/);
    if (dirMatch) {
      const [, key, val] = dirMatch;
      if (val) meta[key.trim()] = val.trim();
      continue;
    }
    const lineChords = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
    lineChords.forEach((c) => chords.add(c));
    if (line.trim()) body.push(line.trim());
  }

  const header = Object.entries(meta)
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`)
    .join("\n");
  const chordList = chords.size ? `\nChords Used: ${[...chords].join(", ")}` : "";
  return [header, chordList, "", ...body].filter((l) => l !== undefined).join("\n").trim();
}

const FIFTHS_TO_KEY = {
  "-7": "Cb", "-6": "Gb", "-5": "Db", "-4": "Ab", "-3": "Eb",
  "-2": "Bb", "-1": "F", "0": "C", "1": "G", "2": "D", "3": "A",
  "4": "E", "5": "B", "6": "F#", "7": "C#",
};

function parseMusicXml(xml) {
  const tag = (name) =>
    xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1]?.trim();
  const attr = (tagName, attrName) =>
    xml.match(new RegExp(`<${tagName}[^>]*${attrName}="([^"]+)"`))?.[1];

  const title = tag("work-title") || tag("movement-title") || "Untitled";
  const composer =
    xml.match(/<creator[^>]*type="composer"[^>]*>([^<]+)<\/creator>/)?.[1]?.trim() || "";
  const fifths = tag("fifths");
  const mode = tag("mode") || "major";
  const key = fifths !== undefined ? `${FIFTHS_TO_KEY[fifths] ?? "?"} ${mode}` : "";
  const beats = tag("beats");
  const beatType = tag("beat-type");
  const timeSig = beats && beatType ? `${beats}/${beatType}` : "";
  const tempo = attr("sound", "tempo");

  const chordRoots = [...xml.matchAll(/<root-step>([^<]+)<\/root-step>/g)].map((m) => m[1]);
  const chordKinds = [...xml.matchAll(/<kind[^>]*>([^<]+)<\/kind>/g)].map((m) =>
    m[1].replace(/-/g, " ")
  );
  const chordList = chordRoots
    .slice(0, 32)
    .map((r, i) => `${r}${chordKinds[i] ? `(${chordKinds[i]})` : ""}`);

  const noteMatches = [
    ...xml.matchAll(
      /<pitch>\s*<step>([A-G])<\/step>\s*(?:<alter>([^<]+)<\/alter>\s*)?<octave>(\d)<\/octave>/g
    ),
  ];
  const notes = noteMatches.slice(0, 32).map((m) => {
    const alter = parseFloat(m[2] ?? "0");
    const acc = alter === 1 ? "#" : alter === -1 ? "b" : "";
    return `${m[1]}${acc}${m[3]}`;
  });

  const lines = [`Title: ${title}`];
  if (composer) lines.push(`Composer: ${composer}`);
  if (key) lines.push(`Key: ${key}`);
  if (timeSig) lines.push(`Time Signature: ${timeSig}`);
  if (tempo) lines.push(`Tempo: ${tempo} BPM`);
  if (chordList.length) lines.push(`\nChord Progression: ${chordList.join(", ")}`);
  if (notes.length) lines.push(`\nNote Sequence: ${notes.join(" ")}`);

  return lines.join("\n");
}

/**
 * Extract plain text from a file buffer.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
export async function parseFile(buffer, filename) {
  const ext = getExtension(filename);

  if (DIRECT_TEXT_EXTENSIONS.has(ext)) return buffer.toString("utf-8");
  if (DOCLING_EXTENSIONS.has(ext))     return convertViaDocling(buffer, filename);
  if (CHORDPRO_EXTENSIONS.has(ext))    return parseChordPro(buffer.toString("utf-8"));
  if (MUSICXML_EXTENSIONS.has(ext))    return parseMusicXml(buffer.toString("utf-8"));

  // Unknown extension — attempt UTF-8 with warning
  console.warn(`[parsing] Unknown extension "${ext}" for "${filename}", attempting UTF-8`);
  return buffer.toString("utf-8");
}
