import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  SessionMessageDraft,
  SessionMessageKind,
  SessionMessageRecord,
  SessionMessageRepository,
  SessionMessageSearchHit,
  SessionEntrySource
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SessionMessageRow {
  created_at: string;
  entry_source: string;
  kind: SessionMessageKind;
  message_id: string;
  payload_json: string;
  sequence: number;
  session_id: string;
}

export class SqliteSessionMessageRepository implements SessionMessageRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(record: SessionMessageDraft): SessionMessageRecord {
    const existing = this.database
      .prepare("SELECT * FROM session_messages WHERE session_id = ? AND message_id = ?")
      .get(record.sessionId, record.messageId) as SessionMessageRow | undefined;
    if (existing !== undefined) {
      return this.updateExisting(existing, record);
    }

    const latest = this.database
      .prepare("SELECT MAX(sequence) AS sequence FROM session_messages WHERE session_id = ?")
      .get(record.sessionId) as { sequence: number | null } | undefined;
    const sequence = (latest?.sequence ?? 0) + 1;
    const createdAt = record.createdAt ?? new Date().toISOString();
    const entrySource = record.entrySource ?? "unknown";
    this.database
      .prepare(
        `INSERT INTO session_messages (
          message_id, session_id, sequence, kind, payload_json, created_at, entry_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.messageId,
        record.sessionId,
        sequence,
        record.kind,
        serializeJsonValue(record.payload),
        createdAt,
        entrySource
      );
    this.indexFts(record.messageId, record.sessionId, record.payload);
    const created = this.database
      .prepare("SELECT * FROM session_messages WHERE session_id = ? AND message_id = ?")
      .get(record.sessionId, record.messageId) as SessionMessageRow | undefined;
    if (created === undefined) {
      throw new Error(`Session message ${record.messageId} was not persisted.`);
    }
    return this.mapRow(created);
  }

  public countBySessionId(sessionId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?")
      .get(sessionId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  public deleteBySessionId(sessionId: string): void {
    const messageIds = this.database
      .prepare("SELECT message_id FROM session_messages WHERE session_id = ?")
      .all(sessionId) as Array<{ message_id: string }>;
    this.database.prepare("DELETE FROM session_messages WHERE session_id = ?").run(sessionId);
    for (const row of messageIds) {
      this.deleteFts(sessionId, row.message_id);
    }
  }

  public findLatestUserPreview(sessionId: string): string | null {
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM session_messages
         WHERE session_id = ? AND kind = 'user'
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const payload = parseJsonValue<JsonObject>(row.payload_json);
    const text = payload.text;
    return typeof text === "string" && text.length > 0 ? summarizeText(text) : null;
  }

  public listBySessionId(sessionId: string): SessionMessageRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM session_messages WHERE session_id = ? ORDER BY sequence ASC")
      .all(sessionId) as unknown as SessionMessageRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public replaceAll(sessionId: string, messages: SessionMessageDraft[]): SessionMessageRecord[] {
    const deduped = dedupeMessageDrafts(messages);
    this.database.exec("BEGIN");
    try {
      this.deleteBySessionId(sessionId);
      const saved: SessionMessageRecord[] = [];
      for (const [index, message] of deduped.entries()) {
        const createdAt = message.createdAt ?? new Date().toISOString();
        const entrySource = message.entrySource ?? "unknown";
        const sequence = index + 1;
        this.database
          .prepare(
            `INSERT INTO session_messages (
              message_id, session_id, sequence, kind, payload_json, created_at, entry_source
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            message.messageId,
            sessionId,
            sequence,
            message.kind,
            serializeJsonValue(message.payload),
            createdAt,
            entrySource
          );
        this.indexFts(message.messageId, sessionId, message.payload);
        saved.push({
          createdAt,
          entrySource,
          kind: message.kind,
          messageId: message.messageId,
          payload: message.payload,
          sequence,
          sessionId
        });
      }
      this.database.exec("COMMIT");
      return saved;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public search(input: {
    limit: number;
    query: string;
    sessionIdPrefix?: string;
  }): SessionMessageSearchHit[] {
    const trimmed = input.query.trim();
    if (trimmed.length === 0) {
      return [];
    }
    const limit = Math.max(1, Math.min(input.limit, 50));
    const rows = this.searchFts(trimmed, input.sessionIdPrefix, limit) ?? this.searchFallback(trimmed, input.sessionIdPrefix, limit);
    return rows;
  }

  private searchFts(
    query: string,
    sessionIdPrefix: string | undefined,
    limit: number
  ): SessionMessageSearchHit[] | null {
    try {
      const rows = this.database
        .prepare(
          `
            SELECT
              fts.message_id AS message_id,
              fts.session_id AS session_id,
              snippet(session_messages_fts, 2, '[', ']', '...', 24) AS preview,
              sm.sequence AS sequence,
              s.title AS session_title
            FROM session_messages_fts fts
            JOIN session_messages sm
              ON sm.message_id = fts.message_id AND sm.session_id = fts.session_id
            JOIN sessions s ON s.session_id = sm.session_id
            WHERE session_messages_fts MATCH ?
              AND (? IS NULL OR sm.session_id LIKE ?)
            ORDER BY rank
            LIMIT ?
          `
        )
        .all(
          toFtsQuery(query),
          sessionIdPrefix ?? null,
          sessionIdPrefix === undefined ? null : `${sessionIdPrefix}%`,
          limit
        ) as Array<{
          message_id: string;
          preview: string;
          sequence: number;
          session_id: string;
          session_title: string;
        }>;

      return rows.map((row) => ({
        messageId: row.message_id,
        preview: row.preview,
        sequence: row.sequence,
        sessionId: row.session_id,
        sessionTitle: row.session_title
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such (table|column)|malformed/i.test(message)) {
        return null;
      }
      throw error;
    }
  }

  private searchFallback(
    query: string,
    sessionIdPrefix: string | undefined,
    limit: number
  ): SessionMessageSearchHit[] {
    const pattern = `%${query.replace(/\s+/gu, "%")}%`;
    const prefixClause =
      sessionIdPrefix === undefined ? "1=1" : "sm.session_id LIKE ?";
    const prefixParams = sessionIdPrefix === undefined ? [] : [`${sessionIdPrefix}%`];
    const rows = this.database
      .prepare(
        `
          SELECT
            sm.message_id AS message_id,
            sm.session_id AS session_id,
            sm.sequence AS sequence,
            s.title AS session_title,
            COALESCE(fts.content, sm.payload_json) AS content
          FROM session_messages sm
          JOIN sessions s ON s.session_id = sm.session_id
          LEFT JOIN session_messages_fts fts
            ON fts.message_id = sm.message_id AND fts.session_id = sm.session_id
          WHERE ${prefixClause}
            AND (
              fts.content LIKE ?
              OR sm.payload_json LIKE ?
            )
          ORDER BY sm.created_at DESC
          LIMIT ?
        `
      )
      .all(...prefixParams, pattern, pattern, limit) as Array<{
        content: string;
        message_id: string;
        sequence: number;
        session_id: string;
        session_title: string;
      }>;

    return rows.map((row) => ({
      messageId: row.message_id,
      preview: summarizeText(row.content.replace(/^"|"$/gu, ""), 120),
      sequence: row.sequence,
      sessionId: row.session_id,
      sessionTitle: row.session_title
    }));
  }

  private deleteFts(sessionId: string, messageId: string): void {
    try {
      this.database
        .prepare("DELETE FROM session_messages_fts WHERE session_id = ? AND message_id = ?")
        .run(sessionId, messageId);
    } catch {
      // FTS table may be unavailable.
    }
  }

  private indexFts(messageId: string, sessionId: string, payload: JsonObject): void {
    const content = extractSearchableContent(payload);
    if (content.length === 0) {
      return;
    }
    try {
      this.deleteFts(sessionId, messageId);
      this.database
        .prepare(
          "INSERT INTO session_messages_fts(session_id, message_id, content) VALUES (?, ?, ?)"
        )
        .run(sessionId, messageId, content);
    } catch {
      // FTS table may be unavailable; fallback search uses payload_json LIKE.
    }
  }

  private updateExisting(existing: SessionMessageRow, record: SessionMessageDraft): SessionMessageRecord {
    const createdAt = record.createdAt ?? existing.created_at;
    const entrySource = record.entrySource ?? existing.entry_source;
    this.database
      .prepare(
        `UPDATE session_messages
         SET kind = ?, payload_json = ?, created_at = ?, entry_source = ?
         WHERE session_id = ? AND message_id = ?`
      )
      .run(
        record.kind,
        serializeJsonValue(record.payload),
        createdAt,
        entrySource,
        existing.session_id,
        record.messageId
      );
    this.indexFts(record.messageId, existing.session_id, record.payload);
    const updated = this.database
      .prepare("SELECT * FROM session_messages WHERE session_id = ? AND message_id = ?")
      .get(existing.session_id, record.messageId) as SessionMessageRow | undefined;
    if (updated === undefined) {
      throw new Error(`Session message ${record.messageId} was not updated.`);
    }
    return this.mapRow(updated);
  }

  private mapRow(row: SessionMessageRow): SessionMessageRecord {
    return {
      createdAt: row.created_at,
      entrySource: row.entry_source as SessionEntrySource,
      kind: row.kind,
      messageId: row.message_id,
      payload: parseJsonValue<JsonObject>(row.payload_json),
      sequence: row.sequence,
      sessionId: row.session_id
    };
  }
}

export function extractSearchableContent(payload: JsonObject): string {
  const parts: string[] = [];
  for (const key of ["text", "message", "code", "title"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(value.trim());
    }
  }
  return parts.join("\n");
}

function dedupeMessageDrafts(messages: SessionMessageDraft[]): SessionMessageDraft[] {
  const deduped = new Map<string, SessionMessageDraft>();
  for (const message of messages) {
    deduped.set(message.messageId, message);
  }
  return [...deduped.values()];
}

function summarizeText(value: string, maxLength = 76): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" ");
}
