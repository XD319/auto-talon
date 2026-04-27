import { describe, expect, it } from "vitest";

import { buildStatusSegments, normalizeStatusLabel } from "../src/tui/components/status-bar.js";

describe("status bar helpers", () => {
  it("prioritizes primary and metrics before details and hints", () => {
    const segments = buildStatusSegments({
      details: ["detail-a"],
      hints: ["hint-a"],
      metrics: [{ label: "metric-a", tone: "accent" }],
      primary: { label: "primary-a", tone: "success" }
    });

    expect(segments.map((segment) => segment.label)).toEqual(["primary-a", "metric-a", "detail-a", "hint-a"]);
  });

  it("truncates overly long labels with ellipsis", () => {
    const label = normalizeStatusLabel("abcdefghijklmnopqrstuvwxyz", 10);
    expect(label).toBe("abcdefg...");
  });
});
