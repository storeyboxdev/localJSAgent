import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed, embedMany } from "ai";

const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-nomic-embed-text-v1.5";

const embeddingProvider = createOpenAICompatible({
  name: "lmstudio-embed",
  apiKey: "lm-studio",
  baseURL: process.env.LMSTUDIO_BASE_URL || "http://localhost:1234/v1",
});

/**
 * Generate a single embedding vector.
 */
export async function generateEmbedding(text) {
  const { embedding } = await embed({
    model: embeddingProvider.textEmbeddingModel(EMBEDDING_MODEL),
    value: text,
  });
  return embedding;
}

/**
 * Generate embeddings for multiple texts.
 * Returns an array of float arrays in the same order as input.
 */
export async function generateEmbeddings(texts) {
  const { embeddings } = await embedMany({
    model: embeddingProvider.textEmbeddingModel(EMBEDDING_MODEL),
    values: texts,
  });
  return embeddings;
}
