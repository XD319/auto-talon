import { describe, expect, it } from "vitest";

import { estimateSessionCostUsd } from "../src/tui/token-pricing.js";

describe("TUI token pricing", () => {
  it("does not double-count OpenAI cached tokens", () => {
    const full = estimateSessionCostUsd("openai", "gpt-4o-mini", {
      inputTokens: 100,
      outputTokens: 20
    });
    const withCache = estimateSessionCostUsd("openai", "gpt-4o-mini", {
      cachedInputTokens: 80,
      inputTokens: 100,
      outputTokens: 20
    });
    expect(withCache).toBeLessThan(full);
  });

  it("keeps Anthropic cache reads additive", () => {
    const withoutCache = estimateSessionCostUsd("anthropic", "claude-sonnet-4-20250514", {
      inputTokens: 2_000,
      outputTokens: 100
    });
    const withCache = estimateSessionCostUsd("anthropic", "claude-sonnet-4-20250514", {
      cachedInputTokens: 8_000,
      inputTokens: 2_000,
      outputTokens: 100
    });
    expect(withCache).toBeGreaterThan(withoutCache);
  });
});
