import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  SessionTranscriptEventDraft,
  SessionTranscriptEventRecord,
  SessionTranscriptRepository
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SessionTranscriptEventRow {
  transcript_event_id: string;
  session_id: string;
  task_id: string | null;
  sequence: number;
  event_type: SessionTranscriptEventRecord["eventType"];
  role: SessionTranscriptEventRecord["role"];
  content: string | null;
  created_at: string;
  payload_json: string;
}

export class SqliteSessionTranscriptRepository implements SessionTranscriptRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(record: SessionTranscriptEventDraft): SessionTranscriptEventRecord {
    const transcriptEventId = record.transcriptEventId ?? randomUUID();
    const latest = this.database
      .prepare("SELECT MAX(sequence) AS sequence FROM session_transcript_events WHERE session_id = ?")
      .get(record.sessionId) as { sequence: number | null } | undefined;
    const sequence = (latest?.sequence ?? 0) + 1;
    const createdAt = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO session_transcript_events (
          transcript_event_id, session_id, task_id, sequence, event_type, role, content, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        transcriptEventId,
        record.sessionId,
        record.taskId ?? null,
        sequence,
        record.eventType,
        record.role ?? null,
        record.content ?? null,
        createdAt,
        serializeJsonValue(record.payload ?? {})
      );
    const created = this.database
      .prepare("SELECT * FROM session_transcript_events WHERE transcript_event_id = ?")
      .get(transcriptEventId) as SessionTranscriptEventRow | undefined;
    if (created === undefined) {
      throw new Error(`Session transcript event ${transcriptEventId} was not persisted.`);
    }
    return this.mapRow(created);
  }

  public listBySessionId(sessionId: string): SessionTranscriptEventRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM session_transcript_events WHERE session_id = ? ORDER BY sequence ASC")
      .all(sessionId) as unknown as SessionTranscriptEventRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public listByTaskId(taskId: string): SessionTranscriptEventRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM session_transcript_events WHERE task_id = ? ORDER BY created_at ASC, sequence ASC")
      .all(taskId) as unknown as SessionTranscriptEventRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: SessionTranscriptEventRow): SessionTranscriptEventRecord {
    return {
      content: row.content,
      createdAt: row.created_at,
      eventType: row.event_type,
      payload: parseJsonValue<JsonObject>(row.payload_json),
      role: row.role,
      sequence: row.sequence,
      sessionId: row.session_id,
      taskId: row.task_id,
      transcriptEventId: row.transcript_event_id
    };
  }
}
