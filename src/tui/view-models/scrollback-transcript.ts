import type { DiffDisplayMode } from "../../presentation/diff-display.js";
import { resolveFileChangeDisplayPath } from "../../presentation/file-diff.js";
import { readTodoSnapshot } from "../../presentation/todo-trace.js";
import type { FileChangeTracePayload, RuntimeOutputEvent, TraceEvent } from "../../types/index.js";
import {
  formatAssistantScrollbackBody,
  formatAssistantScrollbackHeading,
  formatSystemScrollbackLine,
  formatUserScrollbackLine
} from "../message-style.js";
import { sanitizeTerminalText } from "../text-sanitize.js";
import type { ChatMessage } from "./chat-messages.js";
import { formatDiffLineBadge, formatScrollbackDiffPreview } from "./diff-format.js";
import { formatTodoScrollbackCompact } from "./todo-format.js";
import { buildTranscriptRows, type TranscriptViewerMode } from "./transcript-output.js";

export interface ScrollbackTurnState {
  headingWritten: boolean;
  printedText: string;
}

export interface ScrollbackToolState {
  input?: Record<string, unknown>;
  requestedAt?: string;
  startedAt?: string;
  toolName: string;
}

export interface ScrollbackWrapState {
  column: number;
  pending: string;
}

export function formatScrollbackMessage(message: ChatMessage): string | null {
  switch (message.kind) {
    case "user":
      return formatUserScrollbackLine(message.text, { leadingBreak: true });
    case "system":
      return formatSystemScrollbackLine(message.text);
    case "approval_result":
      return formatSystemScrollbackLine(message.text);
    case "error":
      return `┊ ❌ ${sanitizeTerminalText(message.code)}: ${sanitizeTerminalText(message.message)}\n`;
    case "approval":
      return message.status === "pending"
        ? `┊ ⚠ approval requested ${sanitizeTerminalText(message.approval.toolName)}\n`
        : null;
    case "activity":
      return null;
    case "agent": {
      if (message.streaming === true) {
        return null;
      }
      const text = sanitizeTerminalText(message.text).trim();
      if (text.length === 0) {
        return null;
      }
      return `${formatAssistantScrollbackHeading({ leadingBreak: true })}${formatAssistantScrollbackBody(message.text)}`;
    }
  }
}

export function formatScrollbackOutputEvent(
  event: RuntimeOutputEvent,
  turnState: ScrollbackTurnState
): string | null {
  if (event.eventType === "assistant_turn_delta") {
    const delta = sanitizeTerminalText(event.payload.delta);
    if (delta.length === 0) {
      return null;
    }
    const prefix = turnState.headingWritten
      ? ""
      : formatAssistantScrollbackHeading({ leadingBreak: turnState.printedText.length > 0 });
    turnState.headingWritten = true;
    turnState.printedText += delta;
    return `${prefix}${delta}`;
  }

  if (event.eventType === "assistant_turn_completed") {
    if (event.payload.transcriptVisibility === "hidden" && !turnState.headingWritten) {
      return null;
    }
    const text = sanitizeTerminalText(event.payload.text);
    if (text.length === 0) {
      return turnState.headingWritten && !turnState.printedText.endsWith("\n") ? "\n" : null;
    }
    const suffix = text.startsWith(turnState.printedText)
      ? text.slice(turnState.printedText.length)
      : turnState.headingWritten
        ? ""
        : text;
    const prefix = turnState.headingWritten
      ? ""
      : formatAssistantScrollbackHeading({ leadingBreak: turnState.printedText.length > 0 });
    turnState.headingWritten = true;
    turnState.printedText = text;
    const body = `${prefix}${suffix}`;
    return body.endsWith("\n") ? body : `${body}\n`;
  }

  if (event.eventType === "provider_status") {
    return `┊ ${sanitizeTerminalText(event.payload.providerName)}: ${sanitizeTerminalText(event.payload.message)}\n`;
  }

  if (event.eventType === "approval") {
    return `┊ ⚠ approval ${event.payload.status}: ${sanitizeTerminalText(event.payload.toolName)}\n`;
  }

  if (event.eventType === "clarification") {
    const question = event.payload.question ?? event.payload.promptId;
    return `┊ ? clarification ${event.payload.status}: ${sanitizeTerminalText(question)}\n`;
  }

  if (event.eventType === "error") {
    return `┊ ❌ ${sanitizeTerminalText(event.payload.code ?? "error")}: ${sanitizeTerminalText(event.payload.message)}\n`;
  }

  return null;
}

export function updateScrollbackToolState(
  state: Map<string, ScrollbackToolState>,
  event: TraceEvent,
  options: { diffDisplay?: DiffDisplayMode } = {}
): string | null {
  if (
    event.eventType !== "tool_call_requested" &&
    event.eventType !== "tool_call_started" &&
    event.eventType !== "tool_call_finished" &&
    event.eventType !== "tool_call_failed"
  ) {
    return null;
  }

  const toolCallId = event.payload.toolCallId;
  const current = state.get(toolCallId) ?? {
    toolName: event.payload.toolName
  };

  if (event.eventType === "tool_call_requested") {
    state.set(toolCallId, {
      ...current,
      input: event.payload.input,
      requestedAt: event.timestamp,
      toolName: event.payload.toolName
    });
    return null;
  }

  if (event.eventType === "tool_call_started") {
    state.set(toolCallId, {
      ...current,
      startedAt: event.timestamp,
      toolName: event.payload.toolName
    });
    return null;
  }

  const action = toolAction(event.payload.toolName);
  const fallbackTarget = toolTarget(current.input, event);
  const icon = event.eventType === "tool_call_failed" ? "❌" : toolIcon(action);
  const status =
    event.eventType === "tool_call_failed"
      ? ` failed: ${sanitizeTerminalText(event.payload.errorMessage)}`
      : "";
  state.delete(toolCallId);

  if (event.eventType === "tool_call_finished") {
    if (event.payload.toolName === "todo") {
      const snapshot = readTodoSnapshot(event.payload.todoSnapshot);
      if (snapshot !== null) {
        const startedAt = current.startedAt ?? current.requestedAt;
        return formatTodoScrollbackCompact(snapshot, formatElapsed(startedAt, event.timestamp));
      }
    }

    const fileChange = readFileChange(event.payload.fileChange);
    if (fileChange !== null) {
      const target = resolveFileChangeDisplayPath(fileChange.path, {
        unifiedDiffPreview: fileChange.unifiedDiffPreview
      });
      const summaryLine = `┊ ${icon} ${action} ${target} ${formatDiffLineBadge(fileChange.addedLineCount, fileChange.removedLineCount, fileChange.changedLineCount)}${status}\n`;
      const diffPreview = formatScrollbackDiffPreview(
        fileChange.unifiedDiffPreview,
        options.diffDisplay === undefined ? {} : { diffDisplay: options.diffDisplay }
      );
      return diffPreview.length > 0 ? `${summaryLine}${diffPreview}` : summaryLine;
    }
  }

  const startedAt = current.startedAt ?? current.requestedAt;
  const elapsed = formatElapsed(startedAt, event.timestamp);
  return `┊ ${icon} ${action} ${fallbackTarget}${elapsed.length > 0 ? ` ${elapsed}` : ""}${status}\n`;
}

export function wrapScrollbackChunk(
  text: string,
  state: ScrollbackWrapState,
  terminalColumns: number,
  options: { flushPartial?: boolean } = {}
): string {
  const width = normalizeScrollbackWidth(terminalColumns);
  let output = "";

  for (const char of Array.from(text)) {
    if (char === "\n") {
      output += `${state.pending}\n`;
      state.pending = "";
      state.column = 0;
      continue;
    }

    const charWidth = displayWidth(char);
    if (charWidth === 0) {
      state.pending += char;
      continue;
    }

    if (state.column > 0 && state.column + charWidth > width) {
      output += `${state.pending}\n`;
      state.pending = "";
      state.column = 0;
    }

    state.pending += char;
    state.column += Math.min(charWidth, width);

    if (state.column >= width) {
      output += `${state.pending}\n`;
      state.pending = "";
      state.column = 0;
    }
  }

  if (options.flushPartial === true && state.pending.length > 0) {
    output += `${state.pending}\n`;
    state.pending = "";
    state.column = 0;
  }

  return output;
}

export function formatTranscriptForPrint(
  events: RuntimeOutputEvent[],
  options: { mode: TranscriptViewerMode; query?: string; title?: string }
): string {
  const rows = buildTranscriptRows(events, options);
  const title = options.title ?? `Transcript ${options.mode}`;
  if (rows.length === 0) {
    return `${title}\nNo transcript rows matched.\n`;
  }
  return `${title}\n${rows
    .map((row) => {
      const label = row.kind === "assistant" ? "assistant" : row.kind === "input" ? "user" : "activity";
      return `#${row.sequence} ${label}\n${sanitizeTerminalText(row.text)}`;
    })
    .join("\n\n")}\n`;
}

function toolAction(toolName: string): string {
  if (toolName === "todo") {
    return "todo";
  }
  if (toolName.includes("write") || toolName === "patch") {
    return "write";
  }
  if (toolName.includes("read") || toolName === "web_extract") {
    return "read";
  }
  if (toolName === "shell" || toolName.includes("shell")) {
    return "run";
  }
  return toolName;
}

function toolIcon(action: string): string {
  if (action === "todo") {
    return "☑";
  }
  if (action === "write") {
    return "✍";
  }
  if (action === "read") {
    return "📖";
  }
  if (action === "test") {
    return "🧪";
  }
  if (action === "run") {
    return "▶";
  }
  return "•";
}

function toolTarget(input: Record<string, unknown> | undefined, event: TraceEvent): string {
  const candidates = [
    input?.["path"],
    input?.["url"],
    input?.["command"],
    input?.["query"],
    event.eventType === "tool_call_finished" ? event.payload.summary : undefined
  ];
  const value = candidates.find((item): item is string => typeof item === "string" && item.trim().length > 0);
  if (value === undefined) {
    const fallbackToolName =
      "toolName" in event.payload && typeof event.payload.toolName === "string"
        ? event.payload.toolName
        : "tool";
    return sanitizeTerminalText(fallbackToolName);
  }
  const sanitized = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  return sanitized.length > 96 ? `${sanitized.slice(0, 93)}...` : sanitized;
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

function formatElapsed(startedAt: string | undefined, finishedAt: string): string {
  if (startedAt === undefined) {
    return "";
  }
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return "";
  }
  return `${(elapsed / 1_000).toFixed(1)}s`;
}

function normalizeScrollbackWidth(terminalColumns: number): number {
  if (!Number.isFinite(terminalColumns) || terminalColumns <= 1) {
    return 79;
  }
  return Math.max(20, Math.floor(terminalColumns) - 1);
}

function displayWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (codePoint === 0x09) {
    return 4;
  }
  if (isCombiningCodePoint(codePoint)) {
    return 0;
  }
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}
