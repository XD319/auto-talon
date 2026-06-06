import type { DatabaseSync } from "node:sqlite";

import type {
  JsonObject,
  SessionListQuery,
  SessionRecord,
  SessionRepository,
  SessionStatus,
  SessionUpdatePatch
} from "../../types/index.js";
import type { AgentProfileId } from "../../types/profile.js";
import type { SessionDraft } from "../../types/session.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";
import { buildWhereClause, requirePersisted } from "./sqlite-helpers.js";

interface SessionRow {
  session_id: string;
  title: string;
  status: SessionStatus;
  owner_user_id: string;
  cwd: string;
  agent_profile_id: AgentProfileId;
  provider_name: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  metadata_json: string;
}

export class SqliteSessionRepository implements SessionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(session: SessionDraft): SessionRecord {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO sessions (
          session_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name,
          created_at, updated_at, archived_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.sessionId,
        session.title,
        "active",
        session.ownerUserId,
        session.cwd,
        session.agentProfileId,
        session.providerName,
        now,
        now,
        null,
        serializeJsonValue(session.metadata ?? {})
      );

    return requirePersisted(this.findById(session.sessionId), `Session ${session.sessionId} was not persisted.`);
  }

  public getOrCreate(session: SessionDraft): SessionRecord {
    const existing = this.findById(session.sessionId);
    if (existing !== null) {
      return existing;
    }
    try {
      return this.create(session);
    } catch (error) {
      const raced = this.findById(session.sessionId);
      if (raced !== null) {
        return raced;
      }
      throw error;
    }
  }

  public findById(sessionId: string): SessionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public list(query?: SessionListQuery): SessionRecord[] {
    const { params, whereSql } = buildWhereClause([
      { sql: "owner_user_id = ?", value: query?.ownerUserId ?? null, when: query?.ownerUserId !== undefined },
      { sql: "status = ?", value: query?.status ?? null, when: query?.status !== undefined }
    ]);
    const rows = this.database
      .prepare(`SELECT * FROM sessions ${whereSql} ORDER BY updated_at DESC`)
      .all(...params) as unknown as SessionRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(sessionId: string, patch: SessionUpdatePatch): SessionRecord {
    const existing = this.findById(sessionId);
    if (existing === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    const next: SessionRecord = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
      ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
      updatedAt: new Date().toISOString()
    };

    this.database
      .prepare(
        `UPDATE sessions
         SET title = ?, status = ?, updated_at = ?, archived_at = ?, metadata_json = ?
         WHERE session_id = ?`
      )
      .run(
        next.title,
        next.status,
        next.updatedAt,
        next.archivedAt,
        serializeJsonValue(next.metadata),
        sessionId
      );
    return next;
  }

  public findLatestByOwner(ownerUserId: string): SessionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(ownerUserId) as SessionRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  private mapRow(row: SessionRow): SessionRecord {
    return {
      sessionId: row.session_id,
      title: row.title,
      status: row.status,
      ownerUserId: row.owner_user_id,
      cwd: row.cwd,
      agentProfileId: row.agent_profile_id,
      providerName: row.provider_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      metadata: parseJsonValue<JsonObject>(row.metadata_json)
    };
  }
}

