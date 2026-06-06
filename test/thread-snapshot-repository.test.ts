import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("session summary repository", () => {
  it("creates and queries summaries by id and session", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-1",
        title: "session summary"
      });

      const first = storage.sessionSummaries.create({
        decisions: ["picked A"],
        goal: "Initial objective",
        nextActions: ["do A"],
        openLoops: ["pending shell call"],
        sessionSummaryId: "summary-1",
        summary: "first summary",
        sessionId: "session-1",
        trigger: "compact"
      });
      const second = storage.sessionSummaries.create({
        decisions: ["picked B"],
        goal: "Updated objective",
        nextActions: ["do B"],
        openLoops: [],
        sessionSummaryId: "summary-2",
        summary: "second summary",
        sessionId: "session-1",
        trigger: "manual"
      });

      expect(storage.sessionSummaries.findById(first.sessionSummaryId)?.goal).toBe("Initial objective");
      expect(storage.sessionSummaries.findLatestBySession("session-1")?.sessionSummaryId).toBe("summary-2");
      expect(storage.sessionSummaries.listBySession("session-1").map((item) => item.sessionSummaryId)).toEqual([
        "summary-2",
        "summary-1"
      ]);
      expect(second.trigger).toBe("manual");
    } finally {
      storage.close();
    }
  });
});

