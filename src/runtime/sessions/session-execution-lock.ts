import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../../core/app-error.js";

export interface SessionExecutionLockOptions {
  allowParallelSessions?: boolean;
}

export class SessionExecutionLock {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly options: SessionExecutionLockOptions = {}
  ) {}

  public acquire(sessionId: string, taskId: string): void {
    if (this.options.allowParallelSessions === true) {
      return;
    }
    try {
      this.database
        .prepare(
          `INSERT INTO session_locks (session_id, task_id, acquired_at)
           VALUES (?, ?, ?)`
        )
        .run(sessionId, taskId, new Date().toISOString());
    } catch {
      const existing = this.database
        .prepare("SELECT task_id FROM session_locks WHERE session_id = ?")
        .get(sessionId) as { task_id?: string } | undefined;
      throw new AppError({
        code: "session_busy",
        details: {
          activeTaskId: existing?.task_id ?? null,
          sessionId
        },
        message: `Session ${sessionId} already has an active task${existing?.task_id ? `: ${existing.task_id}` : ""}.`
      });
    }
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
}

export function isTerminalTaskStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
