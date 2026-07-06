import { describe, expect, it } from "vitest";

import { AppError } from "../src/core/app-error.js";
import { SessionExecutionLock } from "../src/runtime/sessions/session-execution-lock.js";
import { StorageManager } from "../src/storage/database.js";

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
});
