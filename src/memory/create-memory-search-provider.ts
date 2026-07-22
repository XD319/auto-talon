import type { DatabaseSync } from "node:sqlite";

import {
  FallbackMemorySearchProvider,
  type MemorySearchProvider
} from "./search-provider.js";
import { OpenAiCompatibleMemorySearchProvider } from "./openai-memory-search-provider.js";
import { SqliteFtsMemorySearchProvider } from "./sqlite-fts-memory-search-provider.js";
import type { MemoryEmbeddingRepository, MemoryRecord, MemoryRepository } from "../types/index.js";

export interface CreateMemorySearchProviderInput {
  database: DatabaseSync;
  memoryRepository: MemoryRepository;
  memoryEmbeddings: MemoryEmbeddingRepository;
  provider: "fts" | "openai_compatible";
  openaiCompatible: {
    endpoint: string;
    model: string;
    apiKeyEnv: string;
    dimensions: number;
    timeoutMs: number;
    batchSize: number;
  };
  onFallback?: (reason: string) => void;
}

export function createMemorySearchProvider(
  input: CreateMemorySearchProviderInput
): MemorySearchProvider {
  const fts = new SqliteFtsMemorySearchProvider(input.database, (memoryId) =>
    input.memoryRepository.findById(memoryId)
  );
  if (input.provider !== "openai_compatible") {
    return fts;
  }
  const apiKey = process.env[input.openaiCompatible.apiKeyEnv]?.trim() ?? "";
  if (apiKey.length === 0) {
    input.onFallback?.(
      `Embedding API key env ${input.openaiCompatible.apiKeyEnv} is empty; using FTS only.`
    );
    return fts;
  }
  const primary = new OpenAiCompatibleMemorySearchProvider(
    {
      apiKey,
      batchSize: input.openaiCompatible.batchSize,
      dimensions: input.openaiCompatible.dimensions,
      endpoint: input.openaiCompatible.endpoint,
      model: input.openaiCompatible.model,
      timeoutMs: input.openaiCompatible.timeoutMs
    },
    input.memoryEmbeddings
  );
  return new FallbackMemorySearchProvider(primary, fts, input.onFallback);
}

export function asSqliteFtsProvider(
  provider: MemorySearchProvider | undefined
): SqliteFtsMemorySearchProvider | null {
  if (provider instanceof SqliteFtsMemorySearchProvider) {
    return provider;
  }
  if (provider instanceof FallbackMemorySearchProvider && provider.fallback instanceof SqliteFtsMemorySearchProvider) {
    return provider.fallback;
  }
  return null;
}

export type { MemoryRecord };
