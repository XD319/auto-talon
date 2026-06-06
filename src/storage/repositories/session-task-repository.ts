import type { DatabaseSync } from "node:sqlite";

import type { JsonObject, SessionTaskDraft, SessionTaskRecord, SessionTaskRepository } from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SessionTaskRow {
  run_id: string;
  session_id: string;
  task_id: string;
  run_number: number;
  input: string;
  status: SessionTaskRecord["status"];
  created_at: string;
  finished_at: string | null;
  summary_json: string;
  metadata_json: string;
}

export class SqliteSessionTaskRepository implements SessionTaskRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: SessionTaskDraft): SessionTaskRecord {
    const latest = this.findLatestBySessionId(record.sessionId);
    const runNumber = latest === null ? 1 : latest.runNumber + 1;
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO session_tasks (
          run_id, session_id, task_id, run_number, input, status, created_at, finished_at, summary_json, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.runId,
        record.sessionId,
        record.taskId,
        runNumber,
        record.input,
        record.status,
        createdAt,
        record.finishedAt ?? null,
        serializeJsonValue(record.summary ?? {}),
        serializeJsonValue(record.metadata ?? {})
      );
    const created = this.findByTaskId(record.taskId);
    if (created === null) {
      throw new Error(`Session task for task ${record.taskId} was not persisted.`);
    }
    return created;
  }

  public findByTaskId(taskId: string): SessionTaskRecord | null {
    const row = this.database
      .prepare("SELECT * FROM session_tasks WHERE task_id = ?")
      .get(taskId) as SessionTaskRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listBySessionId(sessionId: string): SessionTaskRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM session_tasks WHERE session_id = ? ORDER BY run_number ASC")
      .all(sessionId) as unknown as SessionTaskRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public findLatestBySessionId(sessionId: string): SessionTaskRecord | null {
    const row = this.database
      .prepare("SELECT * FROM session_tasks WHERE session_id = ? ORDER BY run_number DESC LIMIT 1")
      .get(sessionId) as SessionTaskRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  private mapRow(row: SessionTaskRow): SessionTaskRecord {
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      runNumber: row.run_number,
      input: row.input,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      summary: parseJsonValue<JsonObject>(row.summary_json),
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
