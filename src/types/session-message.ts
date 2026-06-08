import type { JsonObject } from "./common.js";

export const SESSION_MESSAGE_KINDS = [
  "user",
  "agent",
  "system",
  "activity",
  "approval",
  "approval_result",
  "error"
] as const;

export type SessionMessageKind = (typeof SESSION_MESSAGE_KINDS)[number];

export const SESSION_ENTRY_SOURCES = [
  "unknown",
  "tui",
  "cli",
  "gateway",
  "schedule",
  "migration"
] as const;

export type SessionEntrySource = (typeof SESSION_ENTRY_SOURCES)[number];

export interface SessionMessageRecord {
  createdAt: string;
  entrySource: SessionEntrySource;
  kind: SessionMessageKind;
  messageId: string;
  payload: JsonObject;
  sequence: number;
  sessionId: string;
}

export interface SessionMessageDraft {
  createdAt?: string;
  entrySource?: SessionEntrySource;
  kind: SessionMessageKind;
  messageId: string;
  payload: JsonObject;
  sessionId: string;
}

export interface SessionMessageSearchHit {
  messageId: string;
  preview: string;
  sequence: number;
  sessionId: string;
  sessionTitle: string;
}

export interface SessionIndexEntry {
  messageCount: number;
  preview: string | null;
  sessionId: string;
  source: string;
  sourceDetail: string | null;
  title: string;
  updatedAt: string;
}

export interface SessionUiState {
  interactionMode: "agent" | "plan";
  messages: JsonObject[];
  sessionApprovalFingerprints: string[];
}
