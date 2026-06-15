import { describe, expect, it } from "vitest";

import {
  computeCompactThreshold,
  computeHeadroom,
  computePromptTokens,
  contextWindowPercentFromPrompt,
  createHybridTokenCounterState,
  estimateMessageTokens,
  recordApiUsage
} from "../src/runtime/context/token-counter.js";

describe("token-counter", () => {
  it("applies conservative padding to char/4 estimates", () => {
    expect(estimateMessageTokens("abcd")).toBe(2);
  });

  it("combines last API usage with delta messages", () => {
    const state = recordApiUsage(createHybridTokenCounterState(), 10_000, 2);
    const promptTokens = computePromptTokens(state, [
      { content: "system", role: "system" },
      { content: "hello", role: "user" },
      { content: "new turn", role: "assistant" }
    ]);
    expect(promptTokens).toBeGreaterThan(10_000);
  });

  it("computes compact threshold directly from context window ratio", () => {
    const threshold = computeCompactThreshold(64_000, 0.5);
    expect(threshold).toBe(32_000);
    expect(computeHeadroom(threshold, 64_000, 1_000, 8_000)).toBe(23_000);
  });

  it("computes context percentage from the usable context window", () => {
    expect(contextWindowPercentFromPrompt(31_500, 64_000, 1_000)).toBe(50);
  });
});
