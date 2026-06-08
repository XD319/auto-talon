import { describe, expect, it } from "vitest";

import type { SessionIndexEntry } from "../src/types/index.js";
import {
  clampPickerIndex,
  computePickerViewport,
  extractPreviewMessages,
  filterSessionIndexEntries,
  formatPreviewLine,
  matchesSessionFilter,
  movePickerSessionId,
  pickerIndexForSession,
  reconcilePickerSelection,
  SESSION_PICKER_VISIBLE_ROWS
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

  it("resolves picker index from session id", () => {
    expect(pickerIndexForSession(entries, "session-plan-2")).toBe(1);
    expect(pickerIndexForSession(entries, "missing")).toBe(0);
    expect(pickerIndexForSession(entries, null)).toBe(0);
  });

  it("reconciles selection when filtered list changes at the same length", () => {
    const mixed: SessionIndexEntry[] = [
      {
        messageCount: 1,
        preview: "Alpha",
        sessionId: "session-alpha",
        source: "tui",
        sourceDetail: null,
        title: "Alpha task",
        updatedAt: "2026-01-03T00:00:00.000Z"
      },
      {
        messageCount: 1,
        preview: "Beta",
        sessionId: "session-beta",
        source: "tui",
        sourceDetail: null,
        title: "Beta task",
        updatedAt: "2026-01-02T00:00:00.000Z"
      }
    ];
    const narrowed = filterSessionIndexEntries(mixed, "beta");
    expect(narrowed).toHaveLength(1);
    expect(reconcilePickerSelection(narrowed, "session-alpha")).toEqual({
      index: 0,
      sessionId: "session-beta"
    });
  });

  it("keeps anchored session id when list reorders without length change", () => {
    const reordered = [entries[1]!, entries[0]!];
    expect(reconcilePickerSelection(reordered, "session-auth-1")).toEqual({
      index: 1,
      sessionId: "session-auth-1"
    });
    expect(pickerIndexForSession(reordered, "session-auth-1")).toBe(1);
  });

  it("moves picker selection by session id", () => {
    expect(movePickerSessionId(entries, "session-auth-1", 1)).toBe("session-plan-2");
    expect(movePickerSessionId(entries, "session-plan-2", -1)).toBe("session-auth-1");
  });

  it("computes picker viewport windows", () => {
    const manyEntries: SessionIndexEntry[] = Array.from({ length: 20 }, (_, index) => ({
      messageCount: 1,
      preview: `Preview ${index}`,
      sessionId: `session-${index}`,
      source: "tui",
      sourceDetail: null,
      title: `Session ${index}`,
      updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
    }));

    expect(computePickerViewport(manyEntries.slice(0, 5), 0).visibleEntries).toHaveLength(5);
    expect(computePickerViewport(manyEntries, 0)).toMatchObject({
      start: 0,
      end: SESSION_PICKER_VISIBLE_ROWS,
      total: 20
    });
    expect(computePickerViewport(manyEntries, 19)).toMatchObject({
      start: 8,
      end: 20,
      total: 20
    });
    expect(computePickerViewport(manyEntries, 10)).toMatchObject({
      start: 4,
      end: 16,
      total: 20
    });
    expect(computePickerViewport(manyEntries, 10).visibleEntries[6]?.sessionId).toBe("session-10");
  });
});
