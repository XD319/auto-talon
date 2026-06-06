import type {
  ProviderToolDescriptor,
  SessionCompactInput,
  TaskRecord,
  SessionSummaryDraft
} from "../../types/index.js";
import {
  collectStructuredSummaryFields,
  formatStructuredSummary,
  redactSensitiveSummary
} from "../../memory/compact-summarizer.js";

export interface BuildSessionSummaryInput {
  task: TaskRecord;
  compact: SessionCompactInput & {
    reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count" | "iteration_count";
  };
  availableTools: ProviderToolDescriptor[];
  trigger?: SessionSummaryDraft["trigger"];
}

export class ContextCompactor {
  public buildSessionSummary(input: BuildSessionSummaryInput): SessionSummaryDraft {
    const goal = redactSensitiveSummary(
      summarize(
      input.compact.messages.find((message) => message.role === "user")?.content ?? input.task.input,
      500
      )
    );
    const decisions = collectDecisions(input.compact.messages).map((item) => redactSensitiveSummary(item));
    const unresolvedToolCalls = new Map<string, string>();
    const resolvedToolCalls = new Set<string>();
    for (const message of input.compact.messages) {
      if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) {
          unresolvedToolCalls.set(call.toolCallId, call.toolName);
        }
      }
      if (message.role === "tool" && typeof message.toolCallId === "string") {
        resolvedToolCalls.add(message.toolCallId);
      }
    }
    const openLoops = [...unresolvedToolCalls.entries()]
      .filter(([toolCallId]) => !resolvedToolCalls.has(toolCallId))
      .map(([toolCallId, toolName]) => redactSensitiveSummary(`pending ${toolName} (${toolCallId})`));
    const nextActions = collectNextActions(input.compact.messages).map((item) => redactSensitiveSummary(item));
    const structured = collectStructuredSummaryFields(input.compact);
    const summary = redactSensitiveSummary(
      [
        formatStructuredSummary(structured),
        `decisions=${decisions.join("; ") || "[none]"}`,
        `open_loops=${openLoops.join("; ") || "[none]"}`,
        `next_actions=${nextActions.join("; ") || "[none]"}`
      ].join("\n")
    );

    return {
      decisions,
      goal,
      metadata: {
        compactReason: input.compact.reason,
        compactTaskId: input.compact.taskId,
        toolCapabilitySummary: uniqueList([
          ...collectUsedTools(input.compact.messages),
          ...input.availableTools.map((tool) => tool.name)
        ])
      },
      nextActions,
      openLoops,
      runId: null,
      summary,
      taskId: input.task.taskId,
      sessionId: input.task.sessionId ?? "",
      trigger: input.trigger ?? "compact"
    };
  }

  public buildSnapshot(input: BuildSessionSummaryInput): {
    activeMemoryIds: string[];
    blockedReason: string | null;
    goal: string;
    metadata: SessionSummaryDraft["metadata"];
    nextActions: string[];
    openLoops: string[];
    runId: string | null;
    snapshotId: string;
    summary: string;
    taskId: string | null;
    sessionId: string;
    toolCapabilitySummary: string[];
    trigger: SessionSummaryDraft["trigger"];
  } {
    const sessionSummary = this.buildSessionSummary(input);
    const toolCapabilitySummary = Array.isArray(sessionSummary.metadata?.toolCapabilitySummary)
      ? sessionSummary.metadata.toolCapabilitySummary.filter((item): item is string => typeof item === "string")
      : [];
    return {
      activeMemoryIds: [],
      blockedReason: sessionSummary.openLoops[0] ?? null,
      goal: sessionSummary.goal,
      metadata: sessionSummary.metadata,
      nextActions: sessionSummary.nextActions,
      openLoops: sessionSummary.openLoops,
      runId: sessionSummary.runId ?? null,
      snapshotId: sessionSummary.sessionSummaryId ?? "session-memory-compat",
      summary: sessionSummary.summary,
      taskId: sessionSummary.taskId ?? null,
      sessionId: sessionSummary.sessionId,
      toolCapabilitySummary,
      trigger: sessionSummary.trigger
    };
  }
}

function collectUsedTools(messages: SessionCompactInput["messages"]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls) {
        names.push(call.toolName);
      }
    }
    if (message.role === "tool" && typeof message.toolName === "string") {
      names.push(message.toolName);
    }
  }
  return uniqueList(names);
}

function collectNextActions(messages: SessionCompactInput["messages"]): string[] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  if (lastAssistant === undefined) {
    return [];
  }
  const actions: string[] = [];
  if (Array.isArray(lastAssistant.toolCalls) && lastAssistant.toolCalls.length > 0) {
    actions.push(...lastAssistant.toolCalls.map((call) => `run ${call.toolName} (${call.toolCallId})`));
  }
  actions.push(...extractExplicitNextActions(lastAssistant.content));
  return uniqueList(actions).slice(0, 3);
}

function collectDecisions(messages: SessionCompactInput["messages"]): string[] {
  const candidates = messages
    .filter((message) => message.role === "assistant" || message.role === "user")
    .slice(-6)
    .map((message) => normalizeMemoryLine(message.content, 120))
    .filter((message) => message.length > 0);
  return uniqueList(candidates).slice(-3);
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function summarize(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function normalizeMemoryLine(value: string, maxLength: number): string {
  const compact = value
    .replace(/[`#>*_|~]/gu, " ")
    .replace(/\[(.*?)\]\((.*?)\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function extractExplicitNextActions(value: string): string[] {
  const actions: string[] = [];
  let inNextActionSection = false;
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (inNextActionSection) {
        break;
      }
      continue;
    }
    const heading = line.replace(/^[#*\s]+|[:\uFF1A*\s]+$/gu, "").trim();
    if (/^(next actions?|next steps?|\u4e0b\u4e00\u6b65|\u540e\u7eed\u52a8\u4f5c)$/iu.test(heading)) {
      inNextActionSection = true;
      continue;
    }
    if (/^(commitments?|blocked|summary|completed work|\u603b\u7ed3|\u5df2\u5b8c\u6210)$/iu.test(heading)) {
      if (inNextActionSection) {
        break;
      }
      continue;
    }
    if (!inNextActionSection) {
      const keyed = line.match(/^(?:next actions?|next steps?|\u4e0b\u4e00\u6b65)\s*[:\uFF1A]\s*(.+)$/iu);
      if (keyed?.[1] !== undefined) {
        actions.push(normalizeMemoryLine(keyed[1], 120));
      }
      continue;
    }
    const item = line.replace(/^[-*+]\s+/u, "").replace(/^\d+[.)]\s+/u, "").trim();
    if (item.length > 0) {
      actions.push(normalizeMemoryLine(item, 120));
    }
  }
  return actions.filter((item) => item.length > 0);
}
