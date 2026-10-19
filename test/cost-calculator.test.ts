import { describe, expect, it } from "vitest";

import {
  cachedInputAccountingForProvider,
  computeCostUsd
} from "../src/runtime/budget/cost-calculator.js";

describe("cost calculator", () => {
  it("computes exclusive cached cost (Anthropic-style)", () => {
    const cost = computeCostUsd(
      {
        cachedInputTokens: 1_000,
        inputTokens: 2_000,
        outputTokens: 3_000
      },
      {
        cachedInputPerMillion: 0.05,
        inputPerMillion: 1,
        outputPerMillion: 2
      }
    );
    expect(cost).toBeCloseTo(0.00805, 6);
  });

  it("subtracts cached tokens from input when accounting is inclusive", () => {
    const cost = computeCostUsd(
      {
        cachedInputTokens: 1_000,
        inputTokens: 2_000,
        outputTokens: 3_000
      },
      {
        cachedInputPerMillion: 0.05,
        inputPerMillion: 1,
        outputPerMillion: 2
      },
      "inclusive"
    );
    expect(cost).toBeCloseTo(0.00705, 6);
  });

  it("returns null when pricing missing", () => {
    expect(computeCostUsd({ inputTokens: 1, outputTokens: 1 }, null)).toBeNull();
  });

  it("uses the price tier selected by each request's input size", () => {
    const pricing = {
      inputPerMillion: 1.2,
      outputPerMillion: 4.8,
      tiers: [
        { maxInputTokens: 32_000, inputPerMillion: 0.2, outputPerMillion: 0.8 },
        { maxInputTokens: 256_000, inputPerMillion: 0.6, outputPerMillion: 2.4 }
      ]
    };
    expect(computeCostUsd({ inputTokens: 32_000, outputTokens: 10_000 }, pricing)).toBeCloseTo(0.0144, 6);
    expect(computeCostUsd({ inputTokens: 32_001, outputTokens: 10_000 }, pricing)).toBeCloseTo(0.0432006, 6);
  });

  it("uses exclusive accounting for Anthropic-compatible providers", () => {
    expect(cachedInputAccountingForProvider("anthropic")).toBe("exclusive");
    expect(cachedInputAccountingForProvider("minimax")).toBe("exclusive");
  });

  it("uses inclusive accounting for OpenAI-compatible providers", () => {
    expect(cachedInputAccountingForProvider("openai")).toBe("inclusive");
    expect(cachedInputAccountingForProvider("openai-compatible")).toBe("inclusive");
    expect(cachedInputAccountingForProvider("custom-vendor")).toBe("inclusive");
  });
});
