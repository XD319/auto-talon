import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadSession, saveSession } from "../src/tui/session-store.js";

describe("tui session store", () => {
  it("persists interaction mode with saved chat sessions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-session-store-"));
    try {
      await saveSession(workspaceRoot, {
        id: "session-1",
        interactionMode: "plan",
        messages: [],
        title: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });

      const loaded = await loadSession(workspaceRoot, "session-1");

      expect(loaded?.interactionMode).toBe("plan");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
