// lib/parsing.js — file content extraction
// Text/code files: native UTF-8; binary formats (.pdf, .docx, .html): docling-serve

const DOCLING_SERVE_URL = process.env.DOCLING_SERVE_URL ?? "http://localhost:5001";

const DIRECT_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".js", ".ts", ".jsx", ".tsx", ".py", ".json", ".csv",
  ".yaml", ".yml", ".toml", ".xml", ".sh", ".bash", ".c", ".cpp", ".h",
  ".java", ".go", ".rs", ".rb", ".php",
]);

const DOCLING_EXTENSIONS = new Set([".pdf", ".docx", ".html", ".htm"]);

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
    const formData = new FormData();
    formData.append("files", new Blob([buffer]), filename);

    const response = await fetch(`${DOCLING_SERVE_URL}/v1/convert/file`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`docling-serve error (${response.status}): ${errorText}`);
    }

    const json = await response.json();
    return extractTextFromDoclingResponse(json);
  }

  // Unknown extension — attempt UTF-8 with warning
  console.warn(`[parsing] Unknown extension "${ext}" for "${filename}", attempting UTF-8`);
  return buffer.toString("utf-8");
}
