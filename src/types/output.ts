import type { JsonObject } from "./common.js";

export type RuntimeOutputEventType =
  | "task_input"
  | "assistant_turn_started"
  | "assistant_turn_delta"
  | "assistant_turn_completed"
  | "provider_status"
  | "tool_status"
  | "approval"
  | "clarification"
  | "result"
  | "error";

export type RuntimeOutputStage = "planning" | "tooling" | "completion" | "governance";
export type AssistantTurnDisplay = "provisional" | "intermediate" | "final";

export interface RuntimeOutputEventBase<
  TType extends RuntimeOutputEventType = RuntimeOutputEventType,
  TPayload extends JsonObject = JsonObject
> {
  eventId: string;
  eventType: TType;
  payload: TPayload;
  sequence: number;
  stage: RuntimeOutputStage;
  taskId: string;
  threadId: string | null;
  timestamp: string;
}

export interface TaskInputOutputPayload extends JsonObject {
  input: string;
}

export interface AssistantTurnStartedOutputPayload extends JsonObject {
  display: "provisional";
  iteration: number;
  providerName: string;
  turnId: string;
}

export interface AssistantTurnDeltaOutputPayload extends JsonObject {
  delta: string;
  display: "provisional";
  iteration: number;
  turnId: string;
}

export interface AssistantTurnCompletedOutputPayload extends JsonObject {
  display: "intermediate" | "final";
  iteration: number;
  text: string;
  turnId: string;
}

export interface ToolStatusOutputPayload extends JsonObject {
  iteration: number;
  status: "requested" | "started" | "finished" | "failed";
  summary: string;
  toolCallId: string;
  toolName: string;
}

export interface ProviderStatusOutputPayload extends JsonObject {
  kind: "streaming_fallback";
  message: string;
  modelName: string | null;
  providerName: string;
  reason: string;
}

export interface ApprovalOutputPayload extends JsonObject {
  approvalId: string;
  status: "required" | "resolved";
  toolCallId: string;
  toolName: string;
}

export interface ClarificationOutputPayload extends JsonObject {
  promptId: string;
  question?: string;
  status: "required" | "resolved" | "cancelled";
  toolCallId?: string;
}

export interface ResultOutputPayload extends JsonObject {
  output: string | null;
  status: "succeeded" | "failed" | "cancelled";
}

export interface ErrorOutputPayload extends JsonObject {
  code: string | null;
  message: string;
  status: "failed" | "cancelled";
}

export type RuntimeOutputEvent =
  | RuntimeOutputEventBase<"task_input", TaskInputOutputPayload>
  | RuntimeOutputEventBase<"assistant_turn_started", AssistantTurnStartedOutputPayload>
  | RuntimeOutputEventBase<"assistant_turn_delta", AssistantTurnDeltaOutputPayload>
  | RuntimeOutputEventBase<"assistant_turn_completed", AssistantTurnCompletedOutputPayload>
  | RuntimeOutputEventBase<"provider_status", ProviderStatusOutputPayload>
  | RuntimeOutputEventBase<"tool_status", ToolStatusOutputPayload>
  | RuntimeOutputEventBase<"approval", ApprovalOutputPayload>
  | RuntimeOutputEventBase<"clarification", ClarificationOutputPayload>
  | RuntimeOutputEventBase<"result", ResultOutputPayload>
  | RuntimeOutputEventBase<"error", ErrorOutputPayload>;

export type RuntimeOutputEventDraft = Omit<RuntimeOutputEvent, "eventId" | "sequence" | "threadId" | "timestamp"> &
  Partial<Pick<RuntimeOutputEvent, "eventId" | "threadId" | "timestamp">>;
