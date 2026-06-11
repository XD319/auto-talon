import { describe, expect, it } from "vitest";

import { buildContextMetric, buildStatusSegments, normalizeStatusLabel } from "../src/tui/components/status-bar.js";

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

  it("formats context as the compact token metric", () => {
    expect(buildContextMetric(42)).toEqual({ label: "ctx 42%", tone: "success" });
    expect(buildContextMetric(49)).toEqual({ label: "ctx 49%", tone: "success" });
    expect(buildContextMetric(50)).toEqual({ label: "ctx 50%", tone: "warn" });
    expect(buildContextMetric(80)).toEqual({ label: "ctx 80%", tone: "danger" });
  });
});
