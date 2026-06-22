import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  SessionSearchHit,
  SessionSummaryDraft,
  SessionSummaryRecord,
  SessionSummaryRepository
} from "../../types/index.js";
import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SessionSummaryEventRow {
  session_memory_id: string;
  session_id: string;
  run_id: string | null;
  task_id: string | null;
  trigger: SessionSummaryRecord["trigger"];
  summary: string;
  goal: string;
  decisions_json: string;
  open_loops_json: string;
  next_actions_json: string;
  created_at: string;
  metadata_json: string;
}

interface SessionIndexRow {
  session_memory_id: string;
  session_id: string;
  summary: string;
  goal: string;
  decisions: string;
  open_loops: string;
  next_actions: string;
  created_at: string;
  score: number;
}

type SqlParameter = string | number | bigint | Buffer | Uint8Array | null;

export class SqliteSessionSummaryRepository implements SessionSummaryRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: SessionSummaryDraft): SessionSummaryRecord {
    const sessionSummaryId = record.sessionSummaryId ?? randomUUID();
    const createdAt = new Date().toISOString();
    const decisionsJson = serializeJsonValue(record.decisions);
    const openLoopsJson = serializeJsonValue(record.openLoops);
    const nextActionsJson = serializeJsonValue(record.nextActions);
    const metadataJson = serializeJsonValue(record.metadata ?? {});

    this.database.exec("BEGIN");
    try {
      this.database
        .prepare(
          `INSERT INTO session_summary_events (
            session_memory_id, session_id, run_id, task_id, trigger, summary, goal,
            decisions_json, open_loops_json, next_actions_json, created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionSummaryId,
          record.sessionId,
          record.runId ?? null,
          record.taskId ?? null,
          record.trigger,
          record.summary,
          record.goal,
          decisionsJson,
          openLoopsJson,
          nextActionsJson,
          createdAt,
          metadataJson
        );

      this.database
        .prepare(
          `INSERT INTO session_summaries_current (
            session_id, session_memory_id, summary, goal,
            decisions_json, open_loops_json, next_actions_json, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            session_memory_id = excluded.session_memory_id,
            summary = excluded.summary,
            goal = excluded.goal,
            decisions_json = excluded.decisions_json,
            open_loops_json = excluded.open_loops_json,
            next_actions_json = excluded.next_actions_json,
            updated_at = excluded.updated_at,
            metadata_json = excluded.metadata_json`
        )
        .run(
          record.sessionId,
          sessionSummaryId,
          record.summary,
          record.goal,
          decisionsJson,
          openLoopsJson,
          nextActionsJson,
          createdAt,
          metadataJson
        );

      const keywordText = uniqueTokens([
        record.goal,
        record.summary,
        ...record.decisions,
        ...record.openLoops,
        ...record.nextActions
      ]).join(" ");

      this.database
        .prepare(
          `INSERT OR REPLACE INTO session_index (
            session_memory_id, session_id, summary, goal, decisions, open_loops, next_actions, keywords, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionSummaryId,
          record.sessionId,
          record.summary,
          record.goal,
          record.decisions.join("\n"),
          record.openLoops.join("\n"),
          record.nextActions.join("\n"),
          keywordText,
          createdAt
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    const created = this.findById(sessionSummaryId);
    if (created === null) {
      throw new Error(`Session summary ${sessionSummaryId} was not persisted.`);
    }
    return created;
  }

  public findById(sessionSummaryId: string): SessionSummaryRecord | null {
    const row = this.database
      .prepare("SELECT * FROM session_summary_events WHERE session_memory_id = ?")
      .get(sessionSummaryId) as SessionSummaryEventRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public findLatestBySession(sessionId: string): SessionSummaryRecord | null {
    const row = this.database
      .prepare(
        `SELECT
          current.session_id,
          current.session_memory_id,
          events.run_id,
          events.task_id,
          events.trigger,
          current.summary,
          current.goal,
          current.decisions_json,
          current.open_loops_json,
          current.next_actions_json,
          current.updated_at AS created_at,
          current.metadata_json
        FROM session_summaries_current AS current
        LEFT JOIN session_summary_events AS events
          ON events.session_memory_id = current.session_memory_id
        WHERE current.session_id = ?
        LIMIT 1`
      )
      .get(sessionId) as SessionSummaryEventRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listBySession(sessionId: string): SessionSummaryRecord[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM session_summary_events WHERE session_id = ? ORDER BY created_at DESC, rowid DESC"
      )
      .all(sessionId) as unknown as SessionSummaryEventRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public search(input: { limit: number; query: string; sessionId: string }): SessionSearchHit[] {
    const rows = this.searchFts(input) ?? this.searchFallback(input);
    return rows.map((row) => this.mapSearchRow(row));
  }

  public searchGlobal(input: {
    limit: number;
    query: string;
    excludeSessionId?: string | null;
  }): SessionSearchHit[] {
    const rows = this.searchGlobalFts(input) ?? this.searchGlobalFallback(input);
    return rows.map((row) => this.mapSearchRow(row));
  }

  private searchFts(input: { limit: number; query: string; sessionId: string }): SessionIndexRow[] | null {
    const whereClause = "session_id = ? AND session_index MATCH ?";
    const parameters: SqlParameter[] = [input.sessionId, input.query, input.limit];
    return this.searchFtsWithQuery(whereClause, parameters);
  }

  private searchGlobalFts(input: {
    limit: number;
    query: string;
    excludeSessionId?: string | null;
  }): SessionIndexRow[] | null {
    const whereClauses = ["session_index MATCH ?"];
    const parameters: SqlParameter[] = [input.query];
    if (input.excludeSessionId !== undefined && input.excludeSessionId !== null) {
      whereClauses.push("session_id != ?");
      parameters.push(input.excludeSessionId);
    }
    parameters.push(input.limit);
    return this.searchFtsWithQuery(whereClauses.join(" AND "), parameters);
  }

  private searchFtsWithQuery(whereClause: string, parameters: SqlParameter[]): SessionIndexRow[] | null {
    try {
      return this.database
        .prepare(
          `SELECT
            session_memory_id,
            session_id,
            summary,
            goal,
            decisions,
            open_loops,
            next_actions,
            created_at,
            bm25(session_index) AS score
          FROM session_index
          WHERE ${whereClause}
          ORDER BY score ASC, created_at DESC
          LIMIT ?`
        )
        .all(...parameters) as unknown as SessionIndexRow[];
    } catch {
      return null;
    }
  }

  private searchFallback(input: { limit: number; query: string; sessionId: string }): SessionIndexRow[] {
    return this.searchFallbackByScope({
      limit: input.limit,
      query: input.query,
      whereClause: "session_id = ?",
      whereParams: [input.sessionId]
    });
  }

  private searchGlobalFallback(input: {
    limit: number;
    query: string;
    excludeSessionId?: string | null;
  }): SessionIndexRow[] {
    const hasExclude = input.excludeSessionId !== undefined && input.excludeSessionId !== null;
    return this.searchFallbackByScope({
      limit: input.limit,
      query: input.query,
      whereClause: hasExclude ? "session_id != ?" : "1=1",
      whereParams: hasExclude ? [input.excludeSessionId as string] : []
    });
  }

  private searchFallbackByScope(input: {
    limit: number;
    query: string;
    whereClause: string;
      whereParams: SqlParameter[];
  }): SessionIndexRow[] {
    const pattern = `%${input.query.trim().replace(/\s+/gu, "%")}%`;
    return this.database
      .prepare(
        `SELECT
          session_memory_id,
          session_id,
          summary,
          goal,
          decisions,
          open_loops,
          next_actions,
          created_at,
          CASE
            WHEN summary LIKE ? THEN 0.2
            WHEN goal LIKE ? THEN 0.4
            WHEN keywords LIKE ? THEN 0.6
            ELSE 1
          END AS score
        FROM session_index
        WHERE ${input.whereClause}
          AND (
            summary LIKE ?
            OR goal LIKE ?
            OR decisions LIKE ?
            OR open_loops LIKE ?
            OR next_actions LIKE ?
            OR keywords LIKE ?
          )
        ORDER BY score ASC, created_at DESC
        LIMIT ?`
      )
      .all(
        pattern,
        pattern,
        pattern,
        ...input.whereParams,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        input.limit
      ) as unknown as SessionIndexRow[];
  }

  private mapSearchRow(row: SessionIndexRow): SessionSearchHit {
    return {
      createdAt: row.created_at,
      decisions: splitLines(row.decisions),
      goal: row.goal,
      nextActions: splitLines(row.next_actions),
      openLoops: splitLines(row.open_loops),
      score: row.score,
      sessionSummaryId: row.session_memory_id,
      summary: row.summary,
      sessionId: row.session_id
    };
  }

  private mapRow(row: SessionSummaryEventRow): SessionSummaryRecord {
    return {
      createdAt: row.created_at,
      decisions: parseJsonValue<string[]>(row.decisions_json),
      goal: row.goal,
      metadata: parseJsonValue<JsonObject>(row.metadata_json),
      nextActions: parseJsonValue<string[]>(row.next_actions_json),
      openLoops: parseJsonValue<string[]>(row.open_loops_json),
      runId: row.run_id,
      sessionSummaryId: row.session_memory_id,
      summary: row.summary,
      taskId: row.task_id,
      sessionId: row.session_id,
      trigger: row.trigger
    };
  }
}

function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values.join(" ").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
}
