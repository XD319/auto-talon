import type { JsonObject } from "./common.js";

export const SESSION_SUMMARY_TRIGGERS = ["compact", "manual", "resume", "final"] as const;

export type SessionSummaryTrigger = (typeof SESSION_SUMMARY_TRIGGERS)[number];

export interface SessionSummaryRecord {
  sessionSummaryId: string;
  sessionId: string;
  runId: string | null;
  taskId: string | null;
  trigger: SessionSummaryTrigger;
  summary: string;
  goal: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  createdAt: string;
  metadata: JsonObject;
}

export interface SessionSummaryDraft {
  sessionSummaryId?: string;
  sessionId: string;
  runId?: string | null;
  taskId?: string | null;
  trigger: SessionSummaryTrigger;
  summary: string;
  goal: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  metadata?: JsonObject;
}

export interface SessionSearchHit {
  sessionSummaryId: string;
  sessionId: string;
  score: number;
  summary: string;
  goal: string;
  decisions: string[];
  openLoops: string[];
  nextActions: string[];
  createdAt: string;
}
