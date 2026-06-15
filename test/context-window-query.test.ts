import { describe, expect, it } from "vitest";

import {
  parseContextLengthFromModelEntry,
  parseContextLengthFromOllamaModelInfo,
  parseContextLengthFromOllamaParameters,
  resolveOllamaShowUrl
} from "../src/providers/context-window-query.js";

describe("context-window-query", () => {
  it("parses context_length from model entries", () => {
    expect(parseContextLengthFromModelEntry({ context_length: 128_000 })).toBe(128_000);
    expect(parseContextLengthFromModelEntry({ max_model_len: 32_768 })).toBe(32_768);
    expect(parseContextLengthFromModelEntry({ id: "gpt-4o" })).toBeNull();
  });

  it("parses Ollama model_info context length keys", () => {
    expect(
      parseContextLengthFromOllamaModelInfo({
        "llama.context_length": 131_072,
        "general.architecture": "llama"
      })
    ).toBe(131_072);
  });

  it("parses num_ctx from Ollama parameters", () => {
    expect(parseContextLengthFromOllamaParameters("PARAMETER num_ctx 65536\n")).toBe(65_536);
    expect(parseContextLengthFromOllamaParameters("PARAMETER temperature 0.7\n")).toBeNull();
  });

  it("resolves Ollama show URL from OpenAI-compatible base URL", () => {
    expect(resolveOllamaShowUrl("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434/api/show");
    expect(resolveOllamaShowUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/api/show");
  });
});
