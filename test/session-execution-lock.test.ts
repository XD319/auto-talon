import { describe, expect, it } from "vitest";

import { AppError } from "../src/core/app-error.js";
import { SessionExecutionLock } from "../src/runtime/sessions/session-execution-lock.js";
import { StorageManager } from "../src/storage/database.js";

const tokenBudget = {
  inputLimit: 1_000,
  outputLimit: 1_000,
  reservedOutput: 100,
  usedInput: 0,
  usedOutput: 0
};

describe("session execution lock", () => {
  it("blocks a second task on the same session", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const lock = new SessionExecutionLock(storage.database);

    try {
      lock.acquire("session-1", "task-a");
      expect(() => lock.acquire("session-1", "task-b")).toThrow(AppError);
      lock.release("session-1", "task-a");
      lock.acquire("session-1", "task-b");
    } finally {
      storage.close();
    }
  });

  it("replaces a lock left behind by a terminal task", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const lock = new SessionExecutionLock(storage.database);

    try {
      createTask(storage, "session-1", "task-a");
      lock.acquire("session-1", "task-a");
      storage.tasks.update("task-a", {
        startedAt: new Date().toISOString(),
        status: "running"
      });
      storage.tasks.update("task-a", {
        finishedAt: new Date().toISOString(),
        status: "succeeded"
      });

      lock.acquire("session-1", "task-b");

      expect(readLockTaskId(storage, "session-1")).toBe("task-b");
    } finally {
      storage.close();
    }
  });

  it("replaces an orphaned lock after the stale lock window", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const lock = new SessionExecutionLock(storage.database, { staleLockMs: 1 });

    try {
      lock.acquire("session-1", "task-a");
      storage.database
        .prepare("UPDATE session_locks SET acquired_at = ? WHERE session_id = ?")
        .run(new Date(Date.now() - 10_000).toISOString(), "session-1");

      lock.acquire("session-1", "task-b");

      expect(readLockTaskId(storage, "session-1")).toBe("task-b");
    } finally {
      storage.close();
    }
  });
});

function createTask(storage: StorageManager, sessionId: string, taskId: string): void {
  storage.tasks.create({
    agentProfileId: "executor",
    cwd: process.cwd(),
    input: "test task",
    maxIterations: 1,
    providerName: "mock",
    requesterUserId: "user",
    sessionId,
    taskId,
    tokenBudget
  });
}

function readLockTaskId(storage: StorageManager, sessionId: string): string | null {
  const row = storage.database
    .prepare("SELECT task_id FROM session_locks WHERE session_id = ?")
    .get(sessionId) as { task_id?: string } | undefined;
  return row?.task_id ?? null;
}