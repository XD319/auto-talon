import type { JsonObject } from "./common.js";

export const SESSION_TRANSCRIPT_EVENT_TYPES = [
  "user_message",
  "assistant_message",
  "tool_call",
  "tool_result",
  "system_event",
  "compact_boundary",
  "task_result"
] as const;

export type SessionTranscriptEventType = (typeof SESSION_TRANSCRIPT_EVENT_TYPES)[number];

export interface SessionTranscriptEventRecord {
  transcriptEventId: string;
  sessionId: string;
  taskId: string | null;
  sequence: number;
  eventType: SessionTranscriptEventType;
  role: "user" | "assistant" | "tool" | "system" | null;
  content: string | null;
  createdAt: string;
  payload: JsonObject;
}

export interface SessionTranscriptEventDraft {
  transcriptEventId?: string;
  sessionId: string;
  taskId?: string | null;
  eventType: SessionTranscriptEventType;
  role?: "user" | "assistant" | "tool" | "system" | null;
  content?: string | null;
  payload?: JsonObject;
}
