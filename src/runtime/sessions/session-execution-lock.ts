import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../../core/app-error.js";

export interface SessionExecutionLockOptions {
  allowParallelSessions?: boolean;
  staleLockMs?: number;
}

interface SessionLockRow {
  acquired_at: string;
  task_id: string;
}

interface TaskStatusRow {
  status: string;
}

const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1_000;

export class SessionExecutionLock {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly options: SessionExecutionLockOptions = {}
  ) {}

  public acquire(sessionId: string, taskId: string): void {
    if (this.options.allowParallelSessions === true) {
      return;
    }
    if (this.tryAcquire(sessionId, taskId)) {
      return;
    }

    const existing = this.findExistingLock(sessionId);
    if (this.shouldClearLock(existing)) {
      this.deleteLock(sessionId);
      if (this.tryAcquire(sessionId, taskId)) {
        return;
      }
    }

    throw new AppError({
      code: "session_busy",
      details: {
        activeTaskId: existing?.task_id ?? null,
        sessionId
      },
      message: `Session ${sessionId} already has an active task${existing?.task_id ? `: ${existing.task_id}` : ""}.`
    });
  }

  public release(sessionId: string, taskId: string): void {
    this.database
      .prepare("DELETE FROM session_locks WHERE session_id = ? AND task_id = ?")
      .run(sessionId, taskId);
  }

  public isLocked(sessionId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS locked FROM session_locks WHERE session_id = ?")
      .get(sessionId) as { locked?: number } | undefined;
    return row?.locked === 1;
  }

  private tryAcquire(sessionId: string, taskId: string): boolean {
    try {
      this.database
        .prepare(
          `INSERT INTO session_locks (session_id, task_id, acquired_at)
           VALUES (?, ?, ?)`
        )
        .run(sessionId, taskId, new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  private findExistingLock(sessionId: string): SessionLockRow | null {
    const row = this.database
      .prepare("SELECT task_id, acquired_at FROM session_locks WHERE session_id = ?")
      .get(sessionId) as SessionLockRow | undefined;
    return row ?? null;
  }

  private shouldClearLock(lock: SessionLockRow | null): boolean {
    if (lock === null) {
      return false;
    }

    const task = this.database
      .prepare("SELECT status FROM tasks WHERE task_id = ?")
      .get(lock.task_id) as TaskStatusRow | undefined;
    if (task !== undefined) {
      return isTerminalTaskStatus(task.status);
    }

    const acquiredAt = Date.parse(lock.acquired_at);
    if (!Number.isFinite(acquiredAt)) {
      return false;
    }

    return Date.now() - acquiredAt >= (this.options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  }

  private deleteLock(sessionId: string): void {
    this.database
      .prepare("DELETE FROM session_locks WHERE session_id = ?")
      .run(sessionId);
  }
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}