import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { z } from "zod";

const MAX_CHUNK_CHARS = 1000;
const RERANK_TIMEOUT_MS = 30_000;

const provider = createOpenAICompatible({
  name: "lmstudio",
  apiKey: "lm-studio",
  baseURL: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1",
  includeUsage: true,
});

let _model = null;

async function getModel() {
  if (!_model) {
    const baseUrl = (process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1").replace(/\/v1\/?$/, "");
    const res = await fetch(`${baseUrl}/api/v0/models`);
    const data = await res.json();
    const loaded = data.data.find((m) => m.state === "loaded" && (m.type === "llm" || m.type === "vlm"));
    if (!loaded) throw new Error("No loaded LLM found in LM Studio");
    _model = provider(loaded.id);
  }
  return _model;
}

const ScoresSchema = z.array(
  z.object({
    index: z.number().int().min(0),
    score: z.number().min(0).max(1),
  })
);

/**
 * Rerank chunks using LLM-based relevance scoring.
 * All chunks are scored in a single batched LLM call.
 * Returns chunks sorted by rerank_score descending, sliced to limit.
 */
export async function rerankChunks(query, chunks, limit = 5) {
  if (!chunks || chunks.length === 0) return [];

  const model = await getModel();

  let prompt = `You are a relevance scoring assistant. Rate how relevant each document chunk is to the query.
Respond with ONLY a valid JSON array (no markdown, no explanation):
[{"index": 0, "score": 0.0}, {"index": 1, "score": 0.0}, ...]

Where score ranges from 0.0 (completely irrelevant) to 1.0 (perfectly relevant).

Query: ${query}
`;

  chunks.forEach((chunk, i) => {
    const truncated = chunk.content.slice(0, MAX_CHUNK_CHARS);
    prompt += `\nChunk ${i}:\n${truncated}\n`;
  });

  try {
    const response = await Promise.race([
      generateText({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.0,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Rerank scoring timed out")), RERANK_TIMEOUT_MS)
      ),
    ]);

    let rawText = response.text;

    // Strip thinking tags and special tokens
    rawText = rawText.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
    rawText = rawText.replace(/<\|[^|]*\|>/g, "");
    rawText = rawText.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
    rawText = rawText.trim();

    const parsed = JSON.parse(rawText);
    const scores = ScoresSchema.parse(parsed);

    const scoreMap = new Map();
    for (const { index, score } of scores) {
      scoreMap.set(index, score);
    }

    const scored = chunks.map((chunk, i) => ({
      ...chunk,
      rerank_score: scoreMap.get(i) ?? 0,
    }));

    return scored.sort((a, b) => b.rerank_score - a.rerank_score).slice(0, limit);
  } catch (err) {
    console.error("Rerank scoring failed:", err.message);
    return chunks.slice(0, limit).map((chunk) => ({ ...chunk, rerank_score: 0 }));
  }
}
