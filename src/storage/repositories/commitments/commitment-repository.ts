import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  CommitmentDraft,
  CommitmentListQuery,
  CommitmentRecord,
  CommitmentRepository,
  CommitmentUpdatePatch,
  JsonObject
} from "../../../types/index.js";
import { parseJsonValue, serializeJsonValue } from "../json.js";
import { appendLimitClause, buildWhereClause, requirePersisted } from "../sqlite-helpers.js";

interface CommitmentRow {
  commitment_id: string;
  session_id: string;
  task_id: string | null;
  owner_user_id: string;
  title: string;
  summary: string;
  status: CommitmentRecord["status"];
  blocked_reason: string | null;
  pending_decision: string | null;
  source: CommitmentRecord["source"];
  source_trace_id: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  metadata_json: string;
}

export class SqliteCommitmentRepository implements CommitmentRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: CommitmentDraft): CommitmentRecord {
    const now = new Date().toISOString();
    const commitmentId = record.commitmentId ?? randomUUID();
    this.database
      .prepare(
        `INSERT INTO commitments (
          commitment_id, session_id, task_id, owner_user_id, title, summary, status, blocked_reason,
          pending_decision, source, source_trace_id, due_at, created_at, updated_at, completed_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        commitmentId,
        record.sessionId,
        record.taskId ?? null,
        record.ownerUserId,
        record.title,
        record.summary ?? "",
        record.status ?? "open",
        record.blockedReason ?? null,
        record.pendingDecision ?? null,
        record.source ?? "manual",
        record.sourceTraceId ?? null,
        record.dueAt ?? null,
        now,
        now,
        record.completedAt ?? null,
        serializeJsonValue(record.metadata ?? {})
      );
    return requirePersisted(this.findById(commitmentId), `Commitment ${commitmentId} was not persisted.`);
  }

  public findById(commitmentId: string): CommitmentRecord | null {
    const row = this.database
      .prepare("SELECT * FROM commitments WHERE commitment_id = ?")
      .get(commitmentId) as CommitmentRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public list(query: CommitmentListQuery = {}): CommitmentRecord[] {
    const { params: whereParams, whereSql } = buildWhereClause([
      { sql: "session_id = ?", value: query.sessionId ?? null, when: query.sessionId !== undefined },
      { sql: "owner_user_id = ?", value: query.ownerUserId ?? null, when: query.ownerUserId !== undefined },
      { sql: "status = ?", value: query.status ?? null, when: query.status !== undefined },
      {
        sql: `status IN (${(query.statuses ?? []).map(() => "?").join(", ")})`,
        values: query.statuses ?? [],
        when: query.statuses !== undefined && query.statuses.length > 0
      }
    ]);
    const { limitSql, params } = appendLimitClause(whereParams, query.limit);
    const whereClause = whereSql.length === 0 ? "" : ` ${whereSql}`;
    const rows = this.database
      .prepare(`SELECT * FROM commitments${whereClause} ORDER BY updated_at DESC${limitSql}`)
      .all(...params) as unknown as CommitmentRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(commitmentId: string, patch: CommitmentUpdatePatch): CommitmentRecord {
    const existing = this.findById(commitmentId);
    if (existing === null) {
      throw new Error(`Commitment ${commitmentId} was not found.`);
    }
    const next: CommitmentRecord = {
      ...existing,
      ...(patch.taskId !== undefined ? { taskId: patch.taskId } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.blockedReason !== undefined ? { blockedReason: patch.blockedReason } : {}),
      ...(patch.pendingDecision !== undefined ? { pendingDecision: patch.pendingDecision } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
      ...(patch.sourceTraceId !== undefined ? { sourceTraceId: patch.sourceTraceId } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString()
    };
    this.database
      .prepare(
        `UPDATE commitments
         SET task_id = ?, title = ?, summary = ?, status = ?, blocked_reason = ?, pending_decision = ?, source = ?,
             source_trace_id = ?, due_at = ?, updated_at = ?, completed_at = ?, metadata_json = ?
         WHERE commitment_id = ?`
      )
      .run(
        next.taskId,
        next.title,
        next.summary,
        next.status,
        next.blockedReason,
        next.pendingDecision,
        next.source,
        next.sourceTraceId,
        next.dueAt,
        next.updatedAt,
        next.completedAt,
        serializeJsonValue(next.metadata),
        commitmentId
      );
    return next;
  }

  private mapRow(row: CommitmentRow): CommitmentRecord {
    return {
      commitmentId: row.commitment_id,
      sessionId: row.session_id,
      taskId: row.task_id,
      ownerUserId: row.owner_user_id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      blockedReason: row.blocked_reason,
      pendingDecision: row.pending_decision,
      source: row.source,
      sourceTraceId: row.source_trace_id,
      dueAt: row.due_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}
