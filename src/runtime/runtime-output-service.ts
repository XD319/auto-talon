import { randomUUID } from "node:crypto";

import { formatToolCallFailureForUser } from "../presentation/tool-failure-formatters.js";
import type {
  RuntimeOutputEvent,
  RuntimeOutputEventDraft,
  RuntimeOutputRepository,
  TaskRecord,
  TraceEvent
} from "../types/index.js";

export class RuntimeOutputService {
  private readonly listeners = new Set<(event: RuntimeOutputEvent) => void>();

  public constructor(
    private readonly repository: RuntimeOutputRepository,
    private readonly findTask: (taskId: string) => TaskRecord | null
  ) {}

  public record(draft: RuntimeOutputEventDraft): RuntimeOutputEvent {
    const task = this.findTask(draft.taskId);
    const persisted = this.repository.append({
      ...draft,
      eventId: draft.eventId ?? randomUUID(),
      sessionId: draft.sessionId ?? task?.sessionId ?? null,
      timestamp: draft.timestamp ?? new Date().toISOString()
    } as Omit<RuntimeOutputEvent, "sequence">);
    for (const listener of this.listeners) {
      listener(persisted);
    }
    return persisted;
  }

  public listByTaskId(taskId: string): RuntimeOutputEvent[] {
    return this.repository.listByTaskId(taskId);
  }

  public listBySessionId(sessionId: string): RuntimeOutputEvent[] {
    return this.repository.listBySessionId(sessionId);
  }

  public subscribe(listener: (event: RuntimeOutputEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public projectTrace(event: TraceEvent): void {
    const projected = projectTraceToOutput(event);
    if (projected !== null) {
      this.record(projected);
    }
  }
}

function projectTraceToOutput(event: TraceEvent): RuntimeOutputEventDraft | null {
  switch (event.eventType) {
    case "tool_call_requested":
      return {
        eventType: "tool_status",
        payload: {
          iteration: event.payload.iteration,
          status: "requested",
          summary: event.payload.reason,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName
        },
        stage: "tooling",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "tool_call_started":
      return {
        eventType: "tool_status",
        payload: {
          iteration: event.payload.iteration,
          status: "started",
          summary: "Tool started",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName
        },
        stage: "tooling",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "tool_call_finished":
      return {
        eventType: "tool_status",
        payload: {
          ...(event.payload.fileChange === undefined ? {} : { fileChange: event.payload.fileChange }),
          iteration: event.payload.iteration,
          status: "finished",
          summary: event.payload.summary,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName
        },
        stage: "tooling",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "tool_call_failed":
      return {
        eventType: "tool_status",
        payload: {
          iteration: event.payload.iteration,
          status: "failed",
          summary: formatToolCallFailureForUser(event.payload),
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName
        },
        stage: "tooling",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "approval_requested":
    case "approval_resolved":
      return {
        eventType: "approval",
        payload: {
          approvalId: event.payload.approvalId,
          status: event.eventType === "approval_requested" ? "required" : "resolved",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName
        },
        stage: "governance",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "clarify_requested":
      return {
        eventType: "clarification",
        payload: {
          promptId: event.payload.promptId,
          question: event.payload.question,
          status: "required",
          toolCallId: event.payload.toolCallId
        },
        stage: "governance",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "clarify_resolved":
    case "clarify_cancelled":
      return {
        eventType: "clarification",
        payload: {
          promptId: event.payload.promptId,
          status: event.eventType === "clarify_resolved" ? "resolved" : "cancelled"
        },
        stage: "governance",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    case "final_outcome":
      if (event.payload.status === "succeeded") {
        return {
          eventType: "result",
          payload: {
            output: event.payload.output,
            status: "succeeded"
          },
          stage: "completion",
          taskId: event.taskId,
          timestamp: event.timestamp
        };
      }
      return {
        eventType: "error",
        payload: {
          code: event.payload.errorCode,
          message: event.payload.errorMessage ?? `Task ${event.payload.status}.`,
          status: event.payload.status
        },
        stage: "completion",
        taskId: event.taskId,
        timestamp: event.timestamp
      };
    default:
      return null;
  }
}
