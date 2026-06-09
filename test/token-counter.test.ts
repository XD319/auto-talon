import { describe, expect, it } from "vitest";

import {
  computeCompactThreshold,
  computeHeadroom,
  computePromptTokens,
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

  it("computes compact threshold from ratio and buffer", () => {
    const threshold = computeCompactThreshold(64_000, 1_000, 0.8, 8_000);
    expect(threshold).toBe(42_400);
    expect(computeHeadroom(threshold, 64_000, 1_000, 8_000)).toBe(12_600);
  });
});
