import { describe, expect, it } from "vitest";

import type { SessionIndexEntry } from "../src/types/index.js";
import {
  clampPickerIndex,
  extractPreviewMessages,
  filterSessionIndexEntries,
  formatPreviewLine,
  matchesSessionFilter
} from "../src/tui/view-models/session-picker-model.js";

describe("session-picker-model", () => {
  const entries: SessionIndexEntry[] = [
    {
      messageCount: 3,
      preview: "Fix auth module",
      sessionId: "session-auth-1",
      source: "tui",
      sourceDetail: null,
      title: "Refactor auth",
      updatedAt: "2026-01-02T00:00:00.000Z"
    },
    {
      messageCount: 1,
      preview: "Plan release",
      sessionId: "session-plan-2",
      source: "tui",
      sourceDetail: null,
      title: "Release planning",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  it("filters sessions by title, id prefix, and preview", () => {
    expect(filterSessionIndexEntries(entries, "auth")).toHaveLength(1);
    expect(filterSessionIndexEntries(entries, "session-plan")[0]?.sessionId).toBe("session-plan-2");
    expect(filterSessionIndexEntries(entries, "release")[0]?.title).toBe("Release planning");
  });

  it("matches filter helper independently", () => {
    expect(matchesSessionFilter(entries[0]!, "refactor")).toBe(true);
    expect(matchesSessionFilter(entries[1]!, "auth")).toBe(false);
  });

  it("clamps picker index to list bounds", () => {
    expect(clampPickerIndex(-1, 2)).toBe(0);
    expect(clampPickerIndex(5, 2)).toBe(1);
    expect(clampPickerIndex(0, 0)).toBe(0);
  });

  it("extracts preview lines from user and agent messages", () => {
    const preview = extractPreviewMessages([
      { id: "1", kind: "system", text: "ignored", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "2", kind: "user", text: "Hello there", timestamp: "2026-01-01T00:00:01.000Z" },
      { id: "3", kind: "agent", text: "Hi!", timestamp: "2026-01-01T00:00:02.000Z" }
    ]);
    expect(preview).toHaveLength(2);
    expect(formatPreviewLine(preview[0]!)).toContain("You: Hello there");
  });
});
