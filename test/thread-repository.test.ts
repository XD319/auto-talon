import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("thread repositories", () => {
  it("creates, lists, and archives threads", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const created = storage.threads.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        threadId: "thread-1",
        title: "hello thread"
      });
      expect(created.threadId).toBe("thread-1");
      expect(storage.threads.list()).toHaveLength(1);

      const archived = storage.threads.update(created.threadId, {
        archivedAt: "2026-01-01T00:00:00.000Z",
        status: "archived"
      });
      expect(archived.status).toBe("archived");
    } finally {
      storage.close();
    }
  });

  it("creates thread runs and lineage records", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.threads.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        threadId: "thread-2",
        title: "thread with runs"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        input: "hello",
        maxIterations: 3,
        providerName: "mock",
        requesterUserId: "u1",
        taskId: "task-1",
        threadId: "thread-2",
        tokenBudget: { inputLimit: 10, outputLimit: 10, reservedOutput: 2, usedInput: 0, usedOutput: 0 }
      });

      const run = storage.threadRuns.create({
        input: "hello",
        runId: "run-1",
        status: "succeeded",
        taskId: "task-1",
        threadId: "thread-2"
      });
      expect(run.runNumber).toBe(1);
      expect(storage.threadRuns.findByTaskId("task-1")?.runId).toBe("run-1");

      storage.threadLineage.append({
        eventType: "branch",
        lineageId: "lineage-1",
        payload: { from: "run-1" },
        sourceRunId: "run-1",
        targetRunId: "run-1",
        threadId: "thread-2"
      });
      expect(storage.threadLineage.listByThreadId("thread-2")).toHaveLength(1);
    } finally {
      storage.close();
    }
  });
});
