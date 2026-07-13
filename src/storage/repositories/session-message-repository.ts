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
    ownerUserId?: string;
    workspaceRoot?: string;
    roleFilter?: SessionMessageKind[];
    window?: number;
  }): SessionMessageSearchHit[] {
    const trimmed = input.query.trim();
    if (trimmed.length === 0) return [];
    const limit = Math.max(1, Math.min(input.limit, 50));
    const roles: SessionMessageKind[] = input.roleFilter?.length ? input.roleFilter : ["user", "agent"];
    const ranked = this.searchFtsSecure(trimmed, input, roles, limit);
    const trigram = this.searchTrigramSecure(trimmed, input, roles, limit);
    const fallback = this.searchLikeSecure(trimmed, input, roles, limit);
    const merged = new Map<string, SessionMessageSearchHit>();
    for (const hit of [...(ranked ?? []), ...(trigram ?? []), ...fallback]) {
      merged.set(`${hit.sessionId}:${hit.messageId}`, hit);
    }
    return this.enrichHits([...merged.values()].slice(0, limit), input.window ?? 1);
  }

  public scroll(input: {
    sessionId: string;
    aroundMessageId: string;
    window: number;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionMessageSearchHit[] {
    const session = this.database.prepare(
      `SELECT session_id FROM sessions
       WHERE session_id = ?
         AND (? IS NULL OR owner_user_id = ?)
         AND (? IS NULL OR cwd = ?)`
    ).get(
      input.sessionId,
      input.ownerUserId ?? null,
      input.ownerUserId ?? null,
      input.workspaceRoot ?? null,
      input.workspaceRoot ?? null
    ) as { session_id: string } | undefined;
    if (session === undefined) return [];
    const target = this.database.prepare(
      `SELECT sm.*, s.title AS session_title
       FROM session_messages sm JOIN sessions s ON s.session_id = sm.session_id
       WHERE sm.session_id = ? AND sm.message_id = ?`
    ).get(input.sessionId, input.aroundMessageId) as (SessionMessageRow & { session_title: string }) | undefined;
    if (target === undefined) return [];
    return this.enrichHits([{
      messageId: target.message_id,
      preview: summarizeText(extractSearchableContent(parseJsonValue<JsonObject>(target.payload_json)), 120),
      role: target.kind,
      sequence: target.sequence,
      sessionId: target.session_id,
      sessionTitle: target.session_title
    }], Math.max(0, Math.min(input.window, 20)));
  }

  public browse(input: {
    limit: number;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionMessageSearchHit[] {
    const rows = this.database.prepare(`
      SELECT s.session_id, s.title AS session_title,
             sm.message_id, sm.sequence, sm.kind, sm.payload_json
      FROM sessions s
      LEFT JOIN session_messages sm ON sm.session_id = s.session_id
        AND sm.sequence = (SELECT MIN(first.sequence) FROM session_messages first WHERE first.session_id = s.session_id)
      WHERE (? IS NULL OR s.owner_user_id = ?)
        AND (? IS NULL OR s.cwd = ?)
      ORDER BY s.updated_at DESC
      LIMIT ?
    `).all(
      input.ownerUserId ?? null,
      input.ownerUserId ?? null,
      input.workspaceRoot ?? null,
      input.workspaceRoot ?? null,
      Math.max(1, Math.min(input.limit, 50))
    ) as Array<{
      session_id: string; session_title: string; message_id: string | null;
      sequence: number | null; kind: SessionMessageKind | null; payload_json: string | null;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id ?? "",
      preview: row.payload_json === null ? "" : summarizeText(
        extractSearchableContent(parseJsonValue<JsonObject>(row.payload_json)), 120
      ),
      ...(row.kind !== null ? { role: row.kind } : {}),
      sequence: row.sequence ?? 0,
      sessionId: row.session_id,
      sessionTitle: row.session_title,
      totalMessages: this.countBySessionId(row.session_id),
      firstMessageId: row.message_id,
      lastMessageId: this.listBySessionId(row.session_id).at(-1)?.messageId ?? null
    }));
  }

  private searchFtsSecure(
    query: string,
    input: { sessionIdPrefix?: string; ownerUserId?: string; workspaceRoot?: string },
    roles: SessionMessageKind[],
    limit: number
  ): SessionMessageSearchHit[] | null {
    try {
      const placeholders = roles.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT fts.message_id, fts.session_id,
               snippet(session_messages_fts, 2, '[', ']', '...', 24) AS preview,
               sm.sequence, sm.kind, s.title AS session_title
        FROM session_messages_fts fts
        JOIN session_messages sm ON sm.message_id = fts.message_id AND sm.session_id = fts.session_id
        JOIN sessions s ON s.session_id = sm.session_id
        WHERE session_messages_fts MATCH ?
          AND sm.kind IN (${placeholders})
          AND (? IS NULL OR sm.session_id LIKE ?)
          AND (? IS NULL OR s.owner_user_id = ?)
          AND (? IS NULL OR s.cwd = ?)
          AND coalesce(json_extract(sm.payload_json, '$.privacyLevel'), 'internal') <> 'restricted'
        ORDER BY rank LIMIT ?
      `).all(
        toFtsQuery(query), ...roles,
        input.sessionIdPrefix ?? null,
        input.sessionIdPrefix === undefined ? null : `${input.sessionIdPrefix}%`,
        input.ownerUserId ?? null, input.ownerUserId ?? null,
        input.workspaceRoot ?? null, input.workspaceRoot ?? null,
        limit
      ) as Array<{
        message_id: string; preview: string; sequence: number; session_id: string;
        session_title: string; kind: SessionMessageKind;
      }>;
      return rows.map((row) => ({
        messageId: row.message_id, preview: row.preview, role: row.kind,
        sequence: row.sequence, sessionId: row.session_id, sessionTitle: row.session_title
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such (table|column)|malformed|syntax error/i.test(message)) return null;
      throw error;
    }
  }

  private searchTrigramSecure(
    query: string,
    input: { sessionIdPrefix?: string; ownerUserId?: string; workspaceRoot?: string },
    roles: SessionMessageKind[],
    limit: number
  ): SessionMessageSearchHit[] | null {
    try {
      const placeholders = roles.map(() => "?").join(", ");
      const rows = this.database.prepare(`
        SELECT idx.message_id, idx.session_id, idx.content AS preview,
               sm.sequence, sm.kind, s.title AS session_title
        FROM session_messages_trigram idx
        JOIN session_messages sm ON sm.message_id=idx.message_id AND sm.session_id=idx.session_id
        JOIN sessions s ON s.session_id=sm.session_id
        WHERE session_messages_trigram MATCH ? AND sm.kind IN (${placeholders})
          AND (? IS NULL OR sm.session_id LIKE ?)
          AND (? IS NULL OR s.owner_user_id = ?)
          AND (? IS NULL OR s.cwd = ?)
          AND coalesce(json_extract(sm.payload_json, '$.privacyLevel'), 'internal') <> 'restricted'
        ORDER BY rank LIMIT ?
      `).all(
        query, ...roles,
        input.sessionIdPrefix ?? null,
        input.sessionIdPrefix === undefined ? null : `${input.sessionIdPrefix}%`,
        input.ownerUserId ?? null, input.ownerUserId ?? null,
        input.workspaceRoot ?? null, input.workspaceRoot ?? null,
        limit
      ) as Array<{ message_id:string; session_id:string; preview:string; sequence:number; kind:SessionMessageKind; session_title:string }>;
      return rows.map((row) => ({ messageId:row.message_id, sessionId:row.session_id,
        preview:summarizeText(row.preview,120), sequence:row.sequence, role:row.kind, sessionTitle:row.session_title }));
    } catch { return null; }
  }
  private searchLikeSecure(
    query: string,
    input: { sessionIdPrefix?: string; ownerUserId?: string; workspaceRoot?: string },
    roles: SessionMessageKind[],
    limit: number
  ): SessionMessageSearchHit[] {
    const pattern = `%${query.replace(/\s+/gu, "%")}%`;
    const placeholders = roles.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT sm.message_id, sm.session_id, sm.sequence, sm.kind,
             s.title AS session_title, sm.payload_json AS content
      FROM session_messages sm JOIN sessions s ON s.session_id = sm.session_id
      WHERE sm.kind IN (${placeholders})
        AND (? IS NULL OR sm.session_id LIKE ?)
        AND (? IS NULL OR s.owner_user_id = ?)
        AND (? IS NULL OR s.cwd = ?)
        AND coalesce(json_extract(sm.payload_json, '$.privacyLevel'), 'internal') <> 'restricted'
        AND sm.payload_json LIKE ?
      ORDER BY sm.created_at DESC LIMIT ?
    `).all(
      ...roles,
      input.sessionIdPrefix ?? null,
      input.sessionIdPrefix === undefined ? null : `${input.sessionIdPrefix}%`,
      input.ownerUserId ?? null, input.ownerUserId ?? null,
      input.workspaceRoot ?? null, input.workspaceRoot ?? null,
      pattern, limit
    ) as Array<{
      content: string; message_id: string; sequence: number; session_id: string;
      session_title: string; kind: SessionMessageKind;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      preview: summarizeText(row.content.replace(/^"|"$/gu, ""), 120),
      role: row.kind,
      sequence: row.sequence,
      sessionId: row.session_id,
      sessionTitle: row.session_title
    }));
  }

  private enrichHits(hits: SessionMessageSearchHit[], window: number): SessionMessageSearchHit[] {
    return hits.map((hit) => {
      const messages = this.listBySessionId(hit.sessionId);
      const index = messages.findIndex((message) => message.messageId === hit.messageId);
      const safeWindow = Math.max(0, Math.min(window, 20));
      return {
        ...hit,
        before: index < 0 ? [] : messages.slice(Math.max(0, index - safeWindow), index),
        after: index < 0 ? [] : messages.slice(index + 1, index + safeWindow + 1),
        totalMessages: messages.length,
        firstMessageId: messages[0]?.messageId ?? null,
        lastMessageId: messages.at(-1)?.messageId ?? null,
        previousMessageId: index > 0 ? messages[index - 1]?.messageId ?? null : null,
        nextMessageId: index >= 0 && index + 1 < messages.length ? messages[index + 1]?.messageId ?? null : null
      };
    });
  }
  private deleteFts(sessionId: string, messageId: string): void {
    try {
      this.database
        .prepare("DELETE FROM session_messages_fts WHERE session_id = ? AND message_id = ?")
        .run(sessionId, messageId);
      try {
        this.database.prepare("DELETE FROM session_messages_trigram WHERE session_id = ? AND message_id = ?").run(sessionId, messageId);
      } catch {
        // Optional trigram index may be unavailable.
      }
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
      try {
        this.database.prepare("DELETE FROM session_messages_trigram WHERE session_id = ? AND message_id = ?").run(sessionId, messageId);
        this.database.prepare("INSERT INTO session_messages_trigram(session_id, message_id, content) VALUES (?, ?, ?)").run(sessionId, messageId, content);
      } catch {
        // Trigram index is optional.
      }
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
  const tokens = query
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return "";
  }
  const ftsTokens = tokens.flatMap((token) => {
    const escaped = `"${token.replaceAll('"', '""')}"*`;
    if (/[\u3400-\u9fff]/u.test(token) && token.length > 2) {
      const bigrams: string[] = [];
      for (let index = 0; index < token.length - 1; index += 1) {
        bigrams.push(`"${token.slice(index, index + 2).replaceAll('"', '""')}"*`);
      }
      return [escaped, ...bigrams];
    }
    return [escaped];
  });
  const hasCjk = /[\u3400-\u9fff]/u.test(query);
  return hasCjk ? ftsTokens.join(" OR ") : ftsTokens.join(" ");
}
