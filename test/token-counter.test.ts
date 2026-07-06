import { describe, expect, it } from "vitest";

import {
  computeHermesCompactThreshold,
  estimateMessageTokens
} from "../src/runtime/context/token-counter.js";

describe("token counter", () => {
  it("estimates CJK content higher than ASCII-only content", () => {
    const ascii = estimateMessageTokens("a".repeat(200));
    const cjk = estimateMessageTokens("你".repeat(200));
    expect(cjk).toBeGreaterThan(ascii);
  });

  it("applies a safety margin to compact thresholds", () => {
    const raw = Math.floor(10_000 * 0.5);
    const withMargin = computeHermesCompactThreshold(10_000, 0.5);
    expect(withMargin).toBeLessThan(raw);
    expect(withMargin).toBe(Math.floor(10_000 * 0.45));
  });
});
