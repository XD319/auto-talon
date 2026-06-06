import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  SessionLineageDraft,
  SessionLineageRecord,
  SessionLineageRepository
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SessionLineageRow {
  lineage_id: string;
  session_id: string;
  event_type: SessionLineageRecord["eventType"];
  source_run_id: string | null;
  target_run_id: string | null;
  created_at: string;
  payload_json: string;
}

export class SqliteSessionLineageRepository implements SessionLineageRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(record: SessionLineageDraft): SessionLineageRecord {
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO session_lineage (
          lineage_id, session_id, event_type, source_run_id, target_run_id, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.lineageId,
        record.sessionId,
        record.eventType,
        record.sourceRunId ?? null,
        record.targetRunId ?? null,
        createdAt,
        serializeJsonValue(record.payload ?? {})
      );
    const created = this.database
      .prepare("SELECT * FROM session_lineage WHERE lineage_id = ?")
      .get(record.lineageId) as SessionLineageRow | undefined;
    if (created === undefined) {
      throw new Error(`Session lineage ${record.lineageId} was not persisted.`);
    }
    return this.mapRow(created);
  }

  public listBySessionId(sessionId: string): SessionLineageRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM session_lineage WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as unknown as SessionLineageRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: SessionLineageRow): SessionLineageRecord {
    return {
      lineageId: row.lineage_id,
      sessionId: row.session_id,
      eventType: row.event_type,
      sourceRunId: row.source_run_id,
      targetRunId: row.target_run_id,
      createdAt: row.created_at,
      payload: parseJsonValue<JsonObject>(row.payload_json)
    };
  }
}
