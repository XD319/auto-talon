import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  MemoryDraft,
  MemoryQuery,
  MemoryRecord,
  MemoryRepository,
  MemoryUpdatePatch,
  RetentionPolicy
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";
import { appendLimitClause, buildWhereClause, requirePersisted } from "./sqlite-helpers.js";

interface MemoryRow {
  memory_id: string;
  scope: MemoryRecord["scope"];
  scope_key: string;
  title: string;
  content: string;
  summary: string;
  source_json: string;
  source_type: MemoryRecord["sourceType"];
  privacy_level: MemoryRecord["privacyLevel"];
  retention_policy_json: string;
  confidence: number;
  status: MemoryRecord["status"];
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  expires_at: string | null;
  supersedes: string | null;
  conflicts_with_json: string;
  keywords_json: string;
  metadata_json: string;
}

export class SqliteMemoryRepository implements MemoryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: MemoryDraft): MemoryRecord {
    const now = new Date().toISOString();
    const memoryId = randomUUID();
    this.database
      .prepare(
        `
          INSERT INTO memories (
            memory_id,
            scope,
            scope_key,
            title,
            content,
            summary,
            source_json,
            source_type,
            privacy_level,
            retention_policy_json,
            confidence,
            status,
            created_at,
            updated_at,
            last_verified_at,
            expires_at,
            supersedes,
            conflicts_with_json,
            keywords_json,
            metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        memoryId,
        record.scope,
        record.scopeKey,
        record.title,
        record.content,
        record.summary,
        serializeJsonValue(record.source),
        record.source.sourceType,
        record.privacyLevel,
        serializeJsonValue(record.retentionPolicy),
        record.confidence,
        record.status,
        now,
        now,
        record.status === "verified" ? now : null,
        record.expiresAt,
        record.supersedes ?? null,
        serializeJsonValue(record.conflictsWith ?? []),
        serializeJsonValue(record.keywords),
        serializeJsonValue(record.metadata ?? {})
      );

    return requirePersisted(this.findById(memoryId), `Memory ${memoryId} was not persisted.`);
  }

  public findById(memoryId: string): MemoryRecord | null {
    const row = this.database
      .prepare("SELECT * FROM memories WHERE memory_id = ?")
      .get(memoryId) as MemoryRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public list(query: MemoryQuery = {}): MemoryRecord[] {
    const { params: whereParams, whereSql } = buildWhereClause([
      { sql: "scope = ?", value: query.scope === undefined ? null : denormalizeScope(query.scope), when: query.scope !== undefined },
      { sql: "scope_key = ?", value: query.scopeKey ?? null, when: query.scopeKey !== undefined },
      { sql: "status <> 'rejected'", when: query.includeRejected !== true },
      {
        sql: "(expires_at IS NULL OR expires_at > ?)",
        value: new Date().toISOString(),
        when: query.includeExpired !== true
      }
    ]);
    const { limitSql, params } = appendLimitClause(whereParams, query.limit);
    const whereClause = whereSql.length === 0 ? "" : ` ${whereSql}`;
    const rows = this.database
      .prepare(`SELECT * FROM memories${whereClause} ORDER BY updated_at DESC, confidence DESC${limitSql}`)
      .all(...params) as unknown as MemoryRow[];

    return rows.map((row) => this.mapRow(row));
  }

  public update(memoryId: string, patch: MemoryUpdatePatch): MemoryRecord {
    const existing = this.findById(memoryId);
    if (existing === null) {
      throw new Error(`Memory ${memoryId} was not found.`);
    }

    const nextRecord: MemoryRecord = {
      ...existing,
      confidence: patch.confidence ?? existing.confidence,
      conflictsWith: patch.conflictsWith ?? existing.conflictsWith,
      content: patch.content ?? existing.content,
      expiresAt: patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt,
      keywords: patch.keywords ?? existing.keywords,
      lastVerifiedAt:
        patch.lastVerifiedAt === undefined ? existing.lastVerifiedAt : patch.lastVerifiedAt,
      metadata: patch.metadata ?? existing.metadata,
      status: patch.status ?? existing.status,
      summary: patch.summary ?? existing.summary,
      supersedes: patch.supersedes === undefined ? existing.supersedes : patch.supersedes,
      title: patch.title ?? existing.title,
      updatedAt: new Date().toISOString()
    };

    this.database
      .prepare(
        `
          UPDATE memories
          SET title = ?,
              content = ?,
              summary = ?,
              confidence = ?,
              status = ?,
              updated_at = ?,
              last_verified_at = ?,
              expires_at = ?,
              supersedes = ?,
              conflicts_with_json = ?,
              keywords_json = ?,
              metadata_json = ?
          WHERE memory_id = ?
        `
      )
      .run(
        nextRecord.title,
        nextRecord.content,
        nextRecord.summary,
        nextRecord.confidence,
        nextRecord.status,
        nextRecord.updatedAt,
        nextRecord.lastVerifiedAt,
        nextRecord.expiresAt,
        nextRecord.supersedes,
        serializeJsonValue(nextRecord.conflictsWith),
        serializeJsonValue(nextRecord.keywords),
        serializeJsonValue(nextRecord.metadata),
        memoryId
      );

    return this.findById(memoryId) ?? nextRecord;
  }

  private mapRow(row: MemoryRow): MemoryRecord {
    const retentionPolicy = parseJsonValue<RetentionPolicy>(row.retention_policy_json);
    return {
      confidence: row.confidence,
      conflictsWith: parseJsonValue<string[]>(row.conflicts_with_json),
      content: row.content,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      keywords: parseJsonValue<string[]>(row.keywords_json),
      lastVerifiedAt: row.last_verified_at,
      memoryId: row.memory_id,
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      privacyLevel: row.privacy_level,
      retentionPolicy: normalizeRetentionPolicy(retentionPolicy),
      scope: normalizeLegacyScope(row.scope),
      scopeKey: row.scope_key,
      source: parseJsonValue<MemoryRecord["source"]>(row.source_json),
      sourceType: row.source_type,
      status: row.status,
      summary: row.summary,
      supersedes: row.supersedes,
      title: row.title,
      updatedAt: row.updated_at
    };
  }
}

function normalizeLegacyScope(scope: string): MemoryRecord["scope"] {
  if (scope === "agent") {
    return "profile";
  }
  if (scope === "session") {
    return "working";
  }
  return scope as MemoryRecord["scope"];
}

function denormalizeScope(scope: string): string {
  if (scope === "profile") {
    return "profile";
  }
  if (scope === "working") {
    return "session";
  }
  if (scope === "agent") {
    return "agent";
  }
  if (scope === "session") {
    return "session";
  }
  return scope;
}

function normalizeRetentionPolicy(policy: RetentionPolicy): RetentionPolicy {
  const kind = policy.kind as string;
  if (kind === "agent") {
    return {
      ...policy,
      kind: "profile"
    };
  }
  if (kind === "session") {
    return {
      ...policy,
      kind: "working"
    };
  }
  return policy;
}
