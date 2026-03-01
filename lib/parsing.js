// lib/parsing.js — file content extraction
// Text/code files: native UTF-8; binary formats (.pdf, .docx, .html): docling-serve

const DOCLING_SERVE_URL = process.env.DOCLING_SERVE_URL ?? "http://localhost:5001";

const DIRECT_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".js", ".ts", ".jsx", ".tsx", ".py", ".json", ".csv",
  ".yaml", ".yml", ".toml", ".xml", ".sh", ".bash", ".c", ".cpp", ".h",
  ".java", ".go", ".rs", ".rb", ".php",
]);

const DOCLING_EXTENSIONS = new Set([".pdf", ".docx", ".html", ".htm"]);

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

/**
 * Extract plain text from a file buffer.
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<string>}
 */
export async function parseFile(buffer, filename) {
  const ext = getExtension(filename);

  if (DIRECT_TEXT_EXTENSIONS.has(ext)) {
    return buffer.toString("utf-8");
  }

  if (DOCLING_EXTENSIONS.has(ext)) {
    return convertViaDocling(buffer, filename);
  }

  // Unknown extension — attempt UTF-8 with warning
  console.warn(`[parsing] Unknown extension "${ext}" for "${filename}", attempting UTF-8`);
  return buffer.toString("utf-8");
}
