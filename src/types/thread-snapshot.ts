import type { JsonObject } from "./common.js";

export const THREAD_SNAPSHOT_TRIGGERS = ["compact", "manual", "resume"] as const;

export type ThreadSnapshotTrigger = (typeof THREAD_SNAPSHOT_TRIGGERS)[number];

export interface ThreadSnapshotRecord {
  snapshotId: string;
  threadId: string;
  runId: string | null;
  taskId: string | null;
  trigger: ThreadSnapshotTrigger;
  goal: string;
  openLoops: string[];
  blockedReason: string | null;
  nextActions: string[];
  activeMemoryIds: string[];
  toolCapabilitySummary: string[];
  summary: string;
  createdAt: string;
  metadata: JsonObject;
}

export interface ThreadSnapshotDraft {
  snapshotId: string;
  threadId: string;
  trigger: ThreadSnapshotTrigger;
  goal: string;
  openLoops: string[];
  blockedReason?: string | null;
  nextActions: string[];
  activeMemoryIds: string[];
  toolCapabilitySummary: string[];
  summary: string;
  runId?: string | null;
  taskId?: string | null;
  metadata?: JsonObject;
}
