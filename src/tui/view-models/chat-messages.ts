import type { ApprovalRecord, FileChangeTracePayload, ToolCallRecord, TraceEvent } from "../../types/index.js";
import { formatDiffLineBadge } from "../../presentation/file-change-summary.js";
import { resolveFileChangeDisplayPath } from "../../presentation/file-diff.js";
import { formatToolCallFailureForUser } from "../../presentation/tool-failure-formatters.js";

export type ChatMessage =
  | {
      kind: "user";
      id: string;
      text: string;
      timestamp: string;
    }
  | {
      kind: "agent";
      id: string;
      streaming?: boolean;
      text: string;
      timestamp: string;
    }
  | {
      kind: "activity";
      id: string;
      event: TraceEvent;
      text: string;
      timestamp: string;
    }
  | {
      kind: "approval";
      id: string;
      approval: ApprovalRecord;
      toolCall: ToolCallRecord | null;
      status: "pending" | "resolved";
      resolution?: "allow" | "deny";
      timestamp: string;
    }
  | {
      kind: "approval_result";
      id: string;
      action: "allow" | "deny";
      approvalId: string;
      taskId: string;
      text: string;
      timestamp: string;
      toolName: string;
    }
  | {
      kind: "error";
      id: string;
      code: string;
      message: string;
      source: string;
      timestamp: string;
    }
  | {
      kind: "system";
      id: string;
      text: string;
      timestamp: string;
    };

export function toTraceActivityMessage(event: TraceEvent): Extract<ChatMessage, { kind: "activity" }> {
  return {
    id: `activity:${event.eventId}`,
    kind: "activity",
    event,
    text: formatTraceEvent(event),
    timestamp: event.timestamp
  };
}

export function toApprovalMessage(
  approval: ApprovalRecord,
  toolCall: ToolCallRecord | null
): ChatMessage {
  return {
    approval,
    id: `approval:${approval.approvalId}`,
    kind: "approval",
    status: "pending",
    timestamp: approval.requestedAt,
    toolCall
  };
}

export function resolveApprovalMessage(
  message: Extract<ChatMessage, { kind: "approval" }>,
  resolution: "allow" | "deny"
): Extract<ChatMessage, { kind: "approval" }> {
  return {
    ...message,
    resolution,
    status: "resolved",
    timestamp: new Date().toISOString()
  };
}

export function toApprovalResultMessage(
  approval: ApprovalRecord,
  action: "allow" | "deny"
): ChatMessage {
  const label = action === "allow" ? "Approved" : "Denied";
  return {
    action,
    approvalId: approval.approvalId,
    id: `approval-result:${approval.approvalId}:${action}`,
    kind: "approval_result",
    taskId: approval.taskId,
    text: `${label} ${approval.toolName} for task ${approval.taskId.slice(0, 8)}.`,
    timestamp: new Date().toISOString(),
    toolName: approval.toolName
  };
}

export function displayChatMessages(messages: ChatMessage[]): ChatMessage[] {
  const seenActivityKeys = new Set<string>();
  return messages.filter((message) => {
    if (message.kind === "approval" && message.status === "pending") {
      return false;
    }
    if (message.kind !== "activity") {
      return true;
    }
    if (!isHighValueActivity(message.event)) {
      return false;
    }
    const key = activityDisplayKey(message);
    if (seenActivityKeys.has(key)) {
      return false;
    }
    seenActivityKeys.add(key);
    return true;
  });
}

function formatTraceEvent(event: TraceEvent): string {
  switch (event.eventType) {
    case "tool_call_requested": {
      const target = summarizeToolTarget(event.payload.input);
      return target === null
        ? `Queued ${event.payload.toolName} (${event.payload.toolCallId.slice(0, 8)})`
        : `Queued ${event.payload.toolName} ${target}`;
    }
    case "tool_call_started":
      return `Running ${event.payload.toolName} (${event.payload.toolCallId.slice(0, 8)})`;
    case "tool_call_finished":
      return formatFinishedToolCall(event);
    case "tool_call_failed":
      return formatToolCallFailureForUser(event.payload);
    case "approval_requested":
      return `Approval requested for ${event.payload.toolName}`;
    case "approval_resolved":
      return `Approval ${event.payload.status} for ${event.payload.toolName}`;
    case "clarify_requested":
      return `Clarification requested: ${event.payload.question}`;
    case "clarify_resolved":
      return `Clarification ${event.payload.status}`;
    case "clarify_cancelled":
      return "Clarification cancelled";
    case "final_outcome":
      return `final_outcome ${event.payload.status}`;
    case "provider_request_failed":
      return event.payload.errorCategory === "timeout_error"
        ? event.payload.errorMessage ?? "Provider request failed: timeout_error."
        : `Provider request failed: ${event.payload.errorCategory}`;
    case "provider_retry_scheduled":
      return `Provider retry ${event.payload.attempt}/${event.payload.maxRetries}: ${event.payload.errorCategory}; waiting ${event.payload.delayMs}ms`;
    default:
      return `${event.eventType}: ${event.summary}`;
  }
}

function formatFinishedToolCall(event: Extract<TraceEvent, { eventType: "tool_call_finished" }>): string {
  const { summary, toolCallId, toolName, outputPreview } = event.payload;
  if (toolName === "web_extract") {
    const urlTarget = extractUrlTarget(`${summary} ${outputPreview}`);
    return urlTarget === null ? "Fetched webpage" : `Fetched ${urlTarget}`;
  }
  const fileChange = readFileChange(event.payload.fileChange);
  if (fileChange !== null && isFileEditTool(toolName)) {
    return `Write ${resolveFileChangeDisplayPath(fileChange.path, { unifiedDiffPreview: fileChange.unifiedDiffPreview })} (${formatDiffLineBadge(fileChange)})`;
  }
  const compact = collapseWhitespace(summary).slice(0, 120);
  return compact.length > 0 ? `${toolName} done: ${compact}` : `${toolName} done (${toolCallId.slice(0, 8)})`;
}

function summarizeToolTarget(input: Record<string, unknown>): string | null {
  const candidates = [input["path"], input["url"], input["command"], input["query"], input["keyword"]];
  const value = candidates.find((item): item is string => typeof item === "string" && item.length > 0);
  if (value === undefined) {
    return null;
  }
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

function extractUrlTarget(value: string): string | null {
  const urlMatch = /(https?:\/\/[^\s'")\]]+)/iu.exec(value);
  if (urlMatch?.[1] === undefined) {
    return null;
  }
  try {
    const url = new URL(urlMatch[1]);
    const trimmedPath = url.pathname === "/" ? "" : url.pathname;
    const compact = `${url.hostname}${trimmedPath}`;
    return compact.length <= 52 ? compact : `${compact.slice(0, 49)}...`;
  } catch {
    const raw = urlMatch[1];
    return raw.length <= 52 ? raw : `${raw.slice(0, 49)}...`;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function isHighValueActivity(event: TraceEvent): boolean {
  return (
    event.eventType === "approval_requested" ||
    event.eventType === "approval_resolved" ||
    event.eventType === "clarify_requested" ||
    event.eventType === "clarify_resolved" ||
    event.eventType === "clarify_cancelled" ||
    event.eventType === "interrupt" ||
    event.eventType === "provider_request_failed" ||
    event.eventType === "provider_retry_scheduled" ||
    event.eventType === "retry" ||
    event.eventType === "tool_call_failed" ||
    (event.eventType === "tool_call_finished" && isHighValueFinishedTool(event.payload.toolName))
  );
}

export function activityDisplayKey(message: Extract<ChatMessage, { kind: "activity" }>): string {
  return [
    message.event.taskId,
    message.event.eventType,
    message.text.replace(/\s+/gu, " ").trim()
  ].join(":");
}

function isHighValueFinishedTool(toolName: string): boolean {
  return toolName.includes("write") || toolName === "patch" || toolName === "shell";
}

function isFileEditTool(toolName: string): boolean {
  return toolName.includes("write") || toolName === "patch";
}

function readFileChange(value: unknown): FileChangeTracePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") {
    return null;
  }
  return {
    addedLineCount: typeof record.addedLineCount === "number" ? record.addedLineCount : 0,
    changedLineCount: typeof record.changedLineCount === "number" ? record.changedLineCount : 0,
    path: record.path,
    removedLineCount: typeof record.removedLineCount === "number" ? record.removedLineCount : 0,
    unifiedDiffPreview: typeof record.unifiedDiffPreview === "string" ? record.unifiedDiffPreview : ""
  };
}
