import { describe, expect, it } from "vitest";

import { summarizeSession } from "../src/tui/session-store.js";
import { buildWelcomeHome } from "../src/tui/view-models/welcome-home.js";

describe("welcome home", () => {
  it("shows recent sessions and hides starter examples", () => {
    const summary = buildWelcomeHome(
      [
        {
          id: "session-old",
          label: "Old",
          preview: null,
          sessionId: null,
          updatedAt: "2026-01-01T00:00:00.000Z"
        },
        {
          id: "session-new",
          label: "Fix the release check",
          preview: "Fix the release check",
          sessionId: "session-a",
          updatedAt: "2026-01-01T02:00:00.000Z"
        }
      ],
      "session-old",
      { now: new Date("2026-01-01T05:00:00.000Z") }
    );

    expect(summary.entries).toMatchObject([
      {
        detail: "Updated 3h ago",
        label: "Fix the release check",
        sessionId: "session-new"
      }
    ]);
    expect(summary.examples).toEqual([]);
  });

  it("falls back to starter examples when no prior sessions exist", () => {
    const summary = buildWelcomeHome([], "session-current");

    expect(summary.entries).toEqual([]);
    expect(summary.examples.length).toBeGreaterThan(0);
    expect(summary.hint).toBe("Type a request below to start.");
  });

  it("summarizes sessions from explicit title or recent user prompt", () => {
    const titled = summarizeSession({
      id: "session-title",
      messages: [],
      title: "Release work",
      updatedAt: "2026-01-01T02:00:00.000Z"
    });
    const prompted = summarizeSession({
      id: "session-prompt",
      messages: [
        { id: "user:1", kind: "user", text: "Explain the runtime entrypoint", timestamp: "2026-01-01T00:00:00.000Z" }
      ],
      updatedAt: "2026-01-01T01:00:00.000Z"
    });

    expect(titled.label).toBe("Release work");
    expect(prompted.label).toBe("Explain the runtime entrypoint");
    expect(prompted.preview).toBe("Explain the runtime entrypoint");
  });

  it("keeps internal session values out of recent conversation labels", () => {
    const assistant = summarizeSession({
      id: "session-assistant",
      messages: [
        { id: "user:1", kind: "user", text: "Review the TUI entrypoint", timestamp: "2026-01-01T00:00:00.000Z" }
      ],
      title: "assistant",
      updatedAt: "2026-01-01T01:00:00.000Z"
    });
    const empty = summarizeSession({
      id: "session-empty",
      messages: [],
      updatedAt: "2026-01-01T02:00:00.000Z"
    });

    expect(assistant.label).toBe("Review the TUI entrypoint");
    expect(empty.label).toBe("Untitled conversation");
  });
});
