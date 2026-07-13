import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ExperienceDraft,
  ExperienceIndexSignals,
  ExperienceProvenance,
  ExperienceQuery,
  ExperienceRecord,
  ExperienceRepository,
  ExperienceScope,
  ExperienceUpdatePatch,
  JsonObject
} from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";
import { appendLimitClause, buildWhereClause, requirePersisted } from "./sqlite-helpers.js";

interface ExperienceRow {
  experience_id: string;
  type: ExperienceRecord["type"];
  source_type: ExperienceRecord["sourceType"];
  status: ExperienceRecord["status"];
  title: string;
  summary: string;
  content: string;
  scope_json: string;
  scope_name: string;
  scope_key: string;
  confidence: number;
  value_score: number;
  promotion_target: ExperienceRecord["promotionTarget"];
  promoted_memory_id: string | null;
  provenance_json: string;
  task_id: string | null;
  reviewer_id: string | null;
  keywords_json: string;
  keyword_phrases_json: string;
  index_signals_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  promoted_at: string | null;
}

export class SqliteExperienceRepository implements ExperienceRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ExperienceDraft): ExperienceRecord {
    const now = new Date().toISOString();
    const experienceId = randomUUID();
    this.database
      .prepare(
        `
          INSERT INTO experiences (
            experience_id,
            type,
            source_type,
            status,
            title,
            summary,
            content,
            scope_json,
            scope_name,
            scope_key,
            confidence,
            value_score,
            promotion_target,
            promoted_memory_id,
            provenance_json,
            task_id,
            reviewer_id,
            keywords_json,
            keyword_phrases_json,
            index_signals_json,
            metadata_json,
            created_at,
            updated_at,
            reviewed_at,
            promoted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        experienceId,
        record.type,
        record.sourceType,
        record.status,
        record.title,
        record.summary,
        record.content,
        serializeJsonValue(record.scope),
        record.scope.scope,
        record.scope.scopeKey,
        record.confidence,
        record.valueScore,
        record.promotionTarget ?? null,
        null,
        serializeJsonValue(record.provenance),
        record.provenance.taskId,
        record.provenance.reviewerId,
        serializeJsonValue(uniqueStrings(record.keywords)),
        serializeJsonValue(uniqueStrings(record.keywordPhrases ?? [])),
        serializeJsonValue(record.indexSignals),
        serializeJsonValue(record.metadata ?? {}),
        now,
        now,
        null,
        null
      );

    return requirePersisted(this.findById(experienceId), `Experience ${experienceId} was not persisted.`);
  }

  public findById(experienceId: string): ExperienceRecord | null {
    const row = this.database
      .prepare("SELECT * FROM experiences WHERE experience_id = ?")
      .get(experienceId) as ExperienceRow | undefined;

    return row === undefined ? null : this.mapRow(row);
  }

  public list(query: ExperienceQuery = {}): ExperienceRecord[] {
    const { params: whereParams, whereSql } = buildWhereClause([
      { sql: "type = ?", value: query.type ?? null, when: query.type !== undefined },
      { sql: "source_type = ?", value: query.sourceType ?? null, when: query.sourceType !== undefined },
      { sql: "status = ?", value: query.status ?? null, when: query.status !== undefined },
      { sql: "status <> 'archived'", when: query.includeArchived !== true },
      {
        sql: `status IN (${(query.statuses ?? []).map(() => "?").join(", ")})`,
        values: query.statuses ?? [],
        when: query.statuses !== undefined && query.statuses.length > 0
      },
      { sql: "value_score >= ?", value: query.minValueScore ?? null, when: query.minValueScore !== undefined },
      { sql: "task_id = ?", value: query.taskId ?? null, when: query.taskId !== undefined },
      { sql: "reviewer_id = ?", value: query.reviewerId ?? null, when: query.reviewerId !== undefined },
      { sql: "scope_name = ?", value: query.scope ?? null, when: query.scope !== undefined },
      { sql: "scope_key = ?", value: query.scopeKey ?? null, when: query.scopeKey !== undefined }
    ]);
    const { limitSql, params } = appendLimitClause(whereParams, query.limit);
    const whereClause = whereSql.length === 0 ? "" : ` ${whereSql}`;
    const rows = this.database
      .prepare(`SELECT * FROM experiences${whereClause} ORDER BY value_score DESC, updated_at DESC${limitSql}`)
      .all(...params) as unknown as ExperienceRow[];

    return rows.map((row) => this.mapRow(row));
  }

  public update(experienceId: string, patch: ExperienceUpdatePatch): ExperienceRecord {
    const existing = this.findById(experienceId);
    if (existing === null) {
      throw new Error(`Experience ${experienceId} was not found.`);
    }

    const nextRecord: ExperienceRecord = {
      ...existing,
      confidence: patch.confidence ?? existing.confidence,
      content: patch.content ?? existing.content,
      indexSignals: patch.indexSignals ?? existing.indexSignals,
      keywordPhrases: patch.keywordPhrases ?? existing.keywordPhrases,
      keywords: patch.keywords ?? existing.keywords,
      metadata: patch.metadata ?? existing.metadata,
      promotedAt: patch.promotedAt === undefined ? existing.promotedAt : patch.promotedAt,
      promotedMemoryId:
        patch.promotedMemoryId === undefined ? existing.promotedMemoryId : patch.promotedMemoryId,
      promotionTarget:
        patch.promotionTarget === undefined ? existing.promotionTarget : patch.promotionTarget,
      reviewedAt: patch.reviewedAt === undefined ? existing.reviewedAt : patch.reviewedAt,
      status: patch.status ?? existing.status,
      summary: patch.summary ?? existing.summary,
      title: patch.title ?? existing.title,
      updatedAt: new Date().toISOString(),
      valueScore: patch.valueScore ?? existing.valueScore
    };

    this.database
      .prepare(
        `
          UPDATE experiences
          SET status = ?,
              title = ?,
              summary = ?,
              content = ?,
              confidence = ?,
              value_score = ?,
              promotion_target = ?,
              promoted_memory_id = ?,
              keywords_json = ?,
              keyword_phrases_json = ?,
              index_signals_json = ?,
              metadata_json = ?,
              updated_at = ?,
              reviewed_at = ?,
              promoted_at = ?
          WHERE experience_id = ?
        `
      )
      .run(
        nextRecord.status,
        nextRecord.title,
        nextRecord.summary,
        nextRecord.content,
        nextRecord.confidence,
        nextRecord.valueScore,
        nextRecord.promotionTarget,
        nextRecord.promotedMemoryId,
        serializeJsonValue(uniqueStrings(nextRecord.keywords)),
        serializeJsonValue(uniqueStrings(nextRecord.keywordPhrases)),
        serializeJsonValue(nextRecord.indexSignals),
        serializeJsonValue(nextRecord.metadata),
        nextRecord.updatedAt,
        nextRecord.reviewedAt,
        nextRecord.promotedAt,
        experienceId
      );

    return this.findById(experienceId) ?? nextRecord;
  }

  private mapRow(row: ExperienceRow): ExperienceRecord {
    return {
      confidence: row.confidence,
      content: row.content,
      createdAt: row.created_at,
      experienceId: row.experience_id,
      indexSignals: parseJsonValue<ExperienceIndexSignals>(row.index_signals_json),
      keywordPhrases: parseJsonValue<string[]>(row.keyword_phrases_json),
      keywords: parseJsonValue<string[]>(row.keywords_json),
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      promotedAt: row.promoted_at,
      promotedMemoryId: row.promoted_memory_id,
      promotionTarget: row.promotion_target,
      provenance: parseJsonValue<ExperienceProvenance>(row.provenance_json),
      reviewedAt: row.reviewed_at,
      scope: parseJsonValue<ExperienceScope>(row.scope_json),
      sourceType: row.source_type,
      status: row.status,
      summary: row.summary,
      title: row.title,
      type: row.type,
      updatedAt: row.updated_at,
      valueScore: row.value_score
    };
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
