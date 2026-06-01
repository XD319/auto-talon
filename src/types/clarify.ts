import type { RuntimeErrorCode } from "./error.js";

export const CLARIFY_PROMPT_STATUSES = [
  "pending",
  "answered",
  "cancelled",
  "timed_out"
] as const;

export type ClarifyPromptStatus = (typeof CLARIFY_PROMPT_STATUSES)[number];

export interface ClarifyPromptOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface ClarifyPromptQuestion {
  question: string;
  header?: string;
  options: ClarifyPromptOption[];
  allowCustomAnswer: boolean;
  placeholder: string | null;
  multiSelect: boolean;
}

export interface ClarifyPromptRecord {
  promptId: string;
  taskId: string;
  toolCallId: string;
  requesterUserId: string;
  question: string;
  reason: string | null;
  options: ClarifyPromptOption[];
  questions: ClarifyPromptQuestion[];
  allowCustomAnswer: boolean;
  placeholder: string | null;
  status: ClarifyPromptStatus;
  requestedAt: string;
  expiresAt: string;
  answeredAt: string | null;
  answerOptionId: string | null;
  answerText: string | null;
  answers: Record<string, string | string[]> | null;
  response: string | null;
  reviewerId: string | null;
  errorCode: RuntimeErrorCode | null;
}

export interface ClarifyPromptDraft {
  promptId: string;
  taskId: string;
  toolCallId: string;
  requesterUserId: string;
  question: string;
  reason?: string | null;
  options?: ClarifyPromptOption[];
  questions?: ClarifyPromptQuestion[];
  allowCustomAnswer: boolean;
  placeholder?: string | null;
  requestedAt: string;
  expiresAt: string;
}

export interface ClarifyPromptUpdatePatch {
  status?: ClarifyPromptStatus;
  answeredAt?: string | null;
  answerOptionId?: string | null;
  answerText?: string | null;
  answers?: Record<string, string | string[]> | null;
  response?: string | null;
  reviewerId?: string | null;
  errorCode?: RuntimeErrorCode | null;
}
