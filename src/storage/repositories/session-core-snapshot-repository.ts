import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  SessionCoreSnapshotDraft,
  SessionCoreSnapshotRecord,
  SessionCoreSnapshotRepository
} from "../../types/index.js";
import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SnapshotRow {
  snapshot_id: string;
  session_id: string;
  profile_scope_key: string;
  project_scope_key: string;
  profile_memory_ids_json: string;
  project_memory_ids_json: string;
  profile_text: string;
  project_text: string;
  created_at: string;
}

export class SqliteSessionCoreSnapshotRepository implements SessionCoreSnapshotRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: SessionCoreSnapshotDraft): SessionCoreSnapshotRecord {
    const snapshotId = randomUUID();
    const createdAt = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO session_core_snapshots (
        snapshot_id, session_id, profile_scope_key, project_scope_key,
        profile_memory_ids_json, project_memory_ids_json,
        profile_text, project_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotId,
      record.sessionId,
      record.profileScopeKey,
      record.projectScopeKey,
      serializeJsonValue(record.profileMemoryIds),
      serializeJsonValue(record.projectMemoryIds),
      record.profileText,
      record.projectText,
      createdAt
    );
    return this.findBySessionId(record.sessionId) ?? { ...record, snapshotId, createdAt };
  }

  public findBySessionId(sessionId: string): SessionCoreSnapshotRecord | null {
    const row = this.database.prepare(
      "SELECT * FROM session_core_snapshots WHERE session_id = ?"
    ).get(sessionId) as SnapshotRow | undefined;
    if (row === undefined) return null;
    return {
      snapshotId: row.snapshot_id,
      sessionId: row.session_id,
      profileScopeKey: row.profile_scope_key,
      projectScopeKey: row.project_scope_key,
      profileMemoryIds: parseJsonValue<string[]>(row.profile_memory_ids_json),
      projectMemoryIds: parseJsonValue<string[]>(row.project_memory_ids_json),
      profileText: row.profile_text,
      projectText: row.project_text,
      createdAt: row.created_at
    };
  }

  public deleteBySessionId(sessionId: string): void {
    this.database.prepare("DELETE FROM session_core_snapshots WHERE session_id = ?").run(sessionId);
  }
}