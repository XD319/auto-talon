import type { JsonObject } from "./common.js";
import type { AgentProfileId } from "./profile.js";
import type { TaskStatus } from "./task.js";

export const SESSION_STATUSES = ["active", "archived", "deleted"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface SessionRecord {
  sessionId: string;
  title: string;
  status: SessionStatus;
  ownerUserId: string;
  cwd: string;
  agentProfileId: AgentProfileId;
  providerName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metadata: JsonObject;
}

export interface SessionDraft {
  sessionId: string;
  title: string;
  ownerUserId: string;
  cwd: string;
  agentProfileId: AgentProfileId;
  providerName: string;
  metadata?: JsonObject;
}

export interface SessionUpdatePatch {
  title?: string;
  status?: SessionStatus;
  archivedAt?: string | null;
  metadata?: JsonObject;
}

export interface SessionTaskRecord {
  runId: string;
  sessionId: string;
  taskId: string;
  runNumber: number;
  input: string;
  status: TaskStatus;
  createdAt: string;
  finishedAt: string | null;
  summary: JsonObject;
  metadata: JsonObject;
}

export interface SessionTaskDraft {
  runId: string;
  sessionId: string;
  taskId: string;
  input: string;
  status: TaskStatus;
  createdAt?: string;
  finishedAt?: string | null;
  summary?: JsonObject;
  metadata?: JsonObject;
}

export const SESSION_LINEAGE_EVENT_TYPES = ["compress", "branch", "merge", "archive"] as const;

export type SessionLineageEventType = (typeof SESSION_LINEAGE_EVENT_TYPES)[number];

export interface SessionLineageRecord {
  lineageId: string;
  sessionId: string;
  eventType: SessionLineageEventType;
  sourceRunId: string | null;
  targetRunId: string | null;
  createdAt: string;
  payload: JsonObject;
}

export interface SessionLineageDraft {
  lineageId: string;
  sessionId: string;
  eventType: SessionLineageEventType;
  sourceRunId?: string | null;
  targetRunId?: string | null;
  payload?: JsonObject;
}
