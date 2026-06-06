import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("session repositories", () => {
  it("creates, lists, and archives sessions", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const created = storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-1",
        title: "hello thread"
      });
      expect(created.sessionId).toBe("session-1");
      expect(storage.sessions.list()).toHaveLength(1);

      const archived = storage.sessions.update(created.sessionId, {
        archivedAt: "2026-01-01T00:00:00.000Z",
        status: "archived"
      });
      expect(archived.status).toBe("archived");
    } finally {
      storage.close();
    }
  });

  it("creates session runs and lineage records", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-2",
        title: "session with runs"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        input: "hello",
        maxIterations: 3,
        providerName: "mock",
        requesterUserId: "u1",
        taskId: "task-1",
        sessionId: "session-2",
        tokenBudget: { inputLimit: 10, outputLimit: 10, reservedOutput: 2, usedInput: 0, usedOutput: 0 }
      });

      const run = storage.sessionTasks.create({
        input: "hello",
        runId: "run-1",
        status: "succeeded",
        taskId: "task-1",
        sessionId: "session-2"
      });
      expect(run.runNumber).toBe(1);
      expect(storage.sessionTasks.findByTaskId("task-1")?.runId).toBe("run-1");

      storage.sessionLineage.append({
        eventType: "branch",
        lineageId: "lineage-1",
        payload: { from: "run-1" },
        sourceRunId: "run-1",
        targetRunId: "run-1",
        sessionId: "session-2"
      });
      expect(storage.sessionLineage.listBySessionId("session-2")).toHaveLength(1);
    } finally {
      storage.close();
    }
  });
});
