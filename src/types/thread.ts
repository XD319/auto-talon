import type { JsonObject } from "./common.js";
import type { AgentProfileId } from "./profile.js";
import type { TaskStatus } from "./task.js";

export const THREAD_STATUSES = ["active", "archived", "deleted"] as const;

export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export interface ThreadRecord {
  threadId: string;
  title: string;
  status: ThreadStatus;
  ownerUserId: string;
  cwd: string;
  agentProfileId: AgentProfileId;
  providerName: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  metadata: JsonObject;
}

export interface ThreadDraft {
  threadId: string;
  title: string;
  ownerUserId: string;
  cwd: string;
  agentProfileId: AgentProfileId;
  providerName: string;
  metadata?: JsonObject;
}

export interface ThreadUpdatePatch {
  title?: string;
  status?: ThreadStatus;
  archivedAt?: string | null;
  metadata?: JsonObject;
}

export interface ThreadRunRecord {
  runId: string;
  threadId: string;
  taskId: string;
  runNumber: number;
  input: string;
  status: TaskStatus;
  createdAt: string;
  finishedAt: string | null;
  summary: JsonObject;
  metadata: JsonObject;
}

export interface ThreadRunDraft {
  runId: string;
  threadId: string;
  taskId: string;
  input: string;
  status: TaskStatus;
  finishedAt?: string | null;
  summary?: JsonObject;
  metadata?: JsonObject;
}

export const THREAD_LINEAGE_EVENT_TYPES = ["compress", "branch", "merge", "archive"] as const;

export type ThreadLineageEventType = (typeof THREAD_LINEAGE_EVENT_TYPES)[number];

export interface ThreadLineageRecord {
  lineageId: string;
  threadId: string;
  eventType: ThreadLineageEventType;
  sourceRunId: string | null;
  targetRunId: string | null;
  createdAt: string;
  payload: JsonObject;
}

export interface ThreadLineageDraft {
  lineageId: string;
  threadId: string;
  eventType: ThreadLineageEventType;
  sourceRunId?: string | null;
  targetRunId?: string | null;
  payload?: JsonObject;
}
