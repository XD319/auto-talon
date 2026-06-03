import React from "react";
import { Box, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";
import type { ChatMessage } from "../view-models/chat-messages.js";
import type { TraceEvent } from "../../types/index.js";

export interface MessageStreamProps {
  messages: ChatMessage[];
  scrollOffsetRows?: number;
  viewportRows: number;
  width: number;
}

export interface ChatRenderRow {
  bold?: boolean;
  color?: string;
  id: string;
  text: string;
}

export interface MessageMeasurement {
  height: number;
  id: string;
  revision: string;
  rows: ChatRenderRow[];
  width: number;
}

export interface VirtualChatRows {
  end: number;
  maxScrollOffsetRows: number;
  rows: ChatRenderRow[];
  scrollOffsetRows: number;
  start: number;
}

const MIN_WRAP_WIDTH = 20;
const DEFAULT_WRAP_WIDTH = 80;

export function MessageStream({
  messages,
  scrollOffsetRows = 0,
  viewportRows,
  width
}: MessageStreamProps): React.ReactElement {
  const rows = React.useMemo(() => buildChatRenderRows(messages, width), [messages, width]);
  const virtualRows = React.useMemo(
    () => selectVirtualChatRows(rows, viewportRows, scrollOffsetRows),
    [rows, scrollOffsetRows, viewportRows]
  );

  return (
    <Box flexDirection="column" height={Math.max(1, viewportRows)} overflowY="hidden">
      {virtualRows.rows.map((row) => (
        <Text
          key={row.id}
          {...(row.bold === true ? { bold: true } : {})}
          color={row.color ?? theme.fg}
          wrap="truncate-end"
        >
          {row.text.length > 0 ? row.text : " "}
        </Text>
      ))}
    </Box>
  );
}

export function buildChatRenderRows(messages: ChatMessage[], width: number): ChatRenderRow[] {
  const rows: ChatRenderRow[] = [];
  const wrapWidth = normalizeWrapWidth(width);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    rows.push(...buildMessageRenderRows(message, wrapWidth, messages[index - 1]));
  }
  return rows;
}

export function buildMessageRenderRows(
  message: ChatMessage,
  width: number,
  previous?: ChatMessage
): ChatRenderRow[] {
  const rows: ChatRenderRow[] = [];
  const wrapWidth = normalizeWrapWidth(width);
  if (needsTurnSeparator(previous, message)) {
    rows.push({
      color: theme.muted,
      id: `${message.id}:separator`,
      text: ""
    });
  }
  rows.push(...messageToRows(message, wrapWidth));
  return rows;
}

export function messageRevision(message: ChatMessage): string {
  if (message.kind === "agent") {
    return [message.kind, message.text, message.streaming === true ? "streaming" : "final", message.timestamp].join(
      "\u0000"
    );
  }
  if (message.kind === "approval") {
    return [
      message.kind,
      message.status,
      message.resolution ?? "",
      message.approval.approvalId,
      message.approval.status,
      message.approval.toolName,
      message.approval.reason,
      JSON.stringify(message.toolCall?.input ?? null)
    ].join("\u0000");
  }
  if (message.kind === "approval_result") {
    return [message.kind, message.action, message.approvalId, message.text].join("\u0000");
  }
  if (message.kind === "error") {
    return [message.kind, message.code, message.message, message.source].join("\u0000");
  }
  if (message.kind === "activity") {
    return [message.kind, message.event.eventId, message.event.sequence, message.text].join("\u0000");
  }
  return [message.kind, "text" in message ? message.text : "", message.timestamp].join("\u0000");
}

export function measureChatMessage(
  message: ChatMessage,
  width: number,
  previous?: ChatMessage
): MessageMeasurement {
  const rows = buildMessageRenderRows(message, width, previous);
  return {
    height: rows.length,
    id: message.id,
    revision: messageRevision(message),
    rows,
    width: normalizeWrapWidth(width)
  };
}

export function selectVirtualChatRows(
  rows: ChatRenderRow[],
  viewportRows: number,
  scrollOffsetRows: number
): VirtualChatRows {
  const visibleRows = Math.max(1, viewportRows);
  const maxScrollOffsetRows = Math.max(0, rows.length - visibleRows);
  const safeOffset = Math.max(0, Math.min(scrollOffsetRows, maxScrollOffsetRows));
  const end = Math.max(0, rows.length - safeOffset);
  const start = Math.max(0, end - visibleRows);
  return {
    end,
    maxScrollOffsetRows,
    rows: rows.slice(start, end),
    scrollOffsetRows: safeOffset,
    start
  };
}

export function maxVirtualScrollOffset(rowCount: number, viewportRows: number): number {
  return Math.max(0, rowCount - Math.max(1, viewportRows));
}

export function findLatestCompletedAssistantStartRow(
  messages: ChatMessage[],
  rows: ChatRenderRow[]
): { messageId: string; rowIndex: number } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind !== "agent" || message.streaming === true) {
      continue;
    }
    const rowIndex = rows.findIndex((row) => row.id === `${message.id}:speaker`);
    if (rowIndex !== -1) {
      return { messageId: message.id, rowIndex };
    }
  }
  return null;
}

export function scrollOffsetForRowStart(
  rowIndex: number,
  rowCount: number,
  viewportRows: number
): number {
  const visibleRows = Math.max(1, viewportRows);
  const maxOffset = maxVirtualScrollOffset(rowCount, visibleRows);
  if (!Number.isFinite(rowIndex)) {
    return 0;
  }
  return Math.max(0, Math.min(rowCount - visibleRows - Math.max(0, Math.floor(rowIndex)), maxOffset));
}

function messageToRows(message: ChatMessage, wrapWidth: number): ChatRenderRow[] {
  if (message.kind === "user") {
    return textRows(message.id, `> ${sanitizeTerminalText(message.text)}`, wrapWidth, {
      color: theme.selection
    });
  }
  if (message.kind === "agent") {
    return [
      {
        color: theme.agent,
        id: `${message.id}:speaker`,
        text: "assistant"
      },
      ...agentContentRows(message, wrapWidth),
      ...(message.streaming === true
        ? [
            {
              color: theme.accent,
              id: `${message.id}:spinner`,
              text: "..."
            }
          ]
        : [])
    ];
  }
  if (message.kind === "approval") {
    const action = message.status === "resolved" ? message.resolution ?? "allow" : "pending";
    const label = action === "allow" ? "Approved" : action === "deny" ? "Denied" : "Approval requested";
    return textRows(
      message.id,
      `[approval] ${label} ${message.approval.toolName} for task ${message.approval.taskId.slice(0, 8)}.`,
      wrapWidth,
      { color: action === "deny" ? theme.danger : action === "allow" ? theme.success : theme.warn }
    );
  }
  if (message.kind === "approval_result") {
    return textRows(message.id, `[approval] ${message.text}`, wrapWidth, {
      color: message.action === "allow" ? theme.success : theme.danger
    });
  }
  if (message.kind === "error") {
    return textRows(message.id, `x ${message.code}: ${message.message}`, wrapWidth, {
      color: theme.danger
    });
  }
  if (message.kind === "activity") {
    return textRows(message.id, `${activityPrefix(message.event.eventType)} ${sanitizeTerminalText(message.text)}`, wrapWidth, {
      color: activityColor(message.event.eventType)
    });
  }
  return textRows(message.id, sanitizeTerminalText(message.text), wrapWidth, {
    color: theme.muted
  });
}

function agentContentRows(
  message: Extract<ChatMessage, { kind: "agent" }>,
  wrapWidth: number
): ChatRenderRow[] {
  const safeText = sanitizeTerminalText(message.text);
  const blocks = parseMarkdownRows(safeText);
  const rows: ChatRenderRow[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined) {
      continue;
    }
    rows.push(
      ...textRows(`${message.id}:content:${index}`, block.text, wrapWidth, {
        ...(block.bold !== undefined ? { bold: block.bold } : {}),
        ...(block.color !== undefined ? { color: block.color } : {})
      })
    );
  }
  return rows;
}

function parseMarkdownRows(source: string): Array<{ bold?: boolean; color?: string; text: string }> {
  const rows: Array<{ bold?: boolean; color?: string; text: string }> = [];
  const lines = source.split(/\r?\n/u);
  let inCodeBlock = false;
  let codeLanguage: string | undefined;
  for (const line of lines) {
    const fence = /^```\s*([\w-]+)?\s*$/u.exec(line.trim());
    if (fence !== null) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = fence[1];
        rows.push({
          color: theme.muted,
          text: codeLanguage !== undefined && codeLanguage.length > 0 ? `[code ${codeLanguage}]` : "[code]"
        });
      } else {
        inCodeBlock = false;
        codeLanguage = undefined;
      }
      continue;
    }
    if (inCodeBlock) {
      rows.push({
        color: theme.inlineCode,
        text: `  ${line}`
      });
      continue;
    }
    rows.push(markdownLineToRow(line));
  }
  return rows.length > 0 ? rows : [{ color: theme.fg, text: "" }];
}

function markdownLineToRow(line: string): { bold?: boolean; color?: string; text: string } {
  if (line.trim().length === 0) {
    return { color: theme.fg, text: "" };
  }
  const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
  if (heading !== null) {
    return {
      bold: true,
      color: theme.heading,
      text: `${heading[1]} ${stripInlineMarkdown(heading[2] ?? "")}`
    };
  }
  const quote = /^>\s?(.*)$/u.exec(line);
  if (quote !== null) {
    return {
      color: theme.quote,
      text: `| ${stripInlineMarkdown(quote[1] ?? "")}`
    };
  }
  const unordered = /^(\s*)[-*]\s+(.+)$/u.exec(line);
  if (unordered !== null) {
    return {
      color: theme.emphasis,
      text: `${indent(unordered[1] ?? "")}- ${stripInlineMarkdown(unordered[2] ?? "")}`
    };
  }
  const ordered = /^(\s*)(\d+[.)])\s+(.+)$/u.exec(line);
  if (ordered !== null) {
    return {
      color: theme.emphasis,
      text: `${indent(ordered[1] ?? "")}${ordered[2]} ${stripInlineMarkdown(ordered[3] ?? "")}`
    };
  }
  return {
    color: theme.emphasis,
    text: stripInlineMarkdown(line)
  };
}

function textRows(
  idPrefix: string,
  text: string,
  width: number,
  style: { bold?: boolean; color?: string }
): ChatRenderRow[] {
  return wrapText(text, width).map((line, index) => ({
    ...style,
    id: `${idPrefix}:row:${index}`,
    text: line
  }));
}

function wrapText(text: string, width: number): string[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const sourceLines = normalized.split("\n");
  const rows: string[] = [];
  for (const sourceLine of sourceLines) {
    if (sourceLine.length === 0) {
      rows.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const token of Array.from(sourceLine.normalize("NFC"))) {
      const tokenWidth = terminalCellWidth(token);
      if (current.length > 0 && currentWidth + tokenWidth > width) {
        rows.push(current);
        current = "";
        currentWidth = 0;
      }
      current += token;
      currentWidth += tokenWidth;
    }
    if (current.length > 0) {
      rows.push(current);
    }
  }
  return rows.length > 0 ? rows : [""];
}

function terminalCellWidth(value: string): number {
  const codePoint = value.codePointAt(0);
  if (codePoint === undefined) {
    return 0;
  }
  if (
    codePoint === 0x200d ||
    (codePoint >= 0x00 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  return isWideTerminalCodePoint(codePoint) ? 2 : 1;
}

function isWideTerminalCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x231a && codePoint <= 0x231b) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b00 && codePoint <= 0x2bff) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) {
    return DEFAULT_WRAP_WIDTH;
  }
  return Math.max(MIN_WRAP_WIDTH, Math.floor(width));
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/__([^_]+)__/gu, "$1")
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1");
}

function indent(value: string): string {
  return " ".repeat(Math.floor(value.length / 2) * 2);
}

function needsTurnSeparator(previous: ChatMessage | undefined, current: ChatMessage): boolean {
  if (previous === undefined) {
    return false;
  }
  const turnKinds = new Set(["user", "agent"]);
  return turnKinds.has(previous.kind) && turnKinds.has(current.kind) && previous.kind !== current.kind;
}

function activityPrefix(eventType: TraceEvent["eventType"]): string {
  if (eventType === "tool_call_requested" || eventType === "tool_call_started" || eventType === "tool_call_finished") {
    return ">";
  }
  if (eventType === "tool_call_failed" || eventType === "provider_request_failed") {
    return "x";
  }
  if (
    eventType === "approval_requested" ||
    eventType === "approval_resolved" ||
    eventType === "clarify_requested" ||
    eventType === "clarify_resolved" ||
    eventType === "clarify_cancelled"
  ) {
    return "!";
  }
  return "-";
}

function activityColor(eventType: TraceEvent["eventType"]): string {
  if (eventType === "tool_call_failed" || eventType === "provider_request_failed") {
    return theme.danger;
  }
  if (
    eventType === "approval_requested" ||
    eventType === "clarify_requested" ||
    eventType === "clarify_resolved" ||
    eventType === "clarify_cancelled" ||
    eventType === "retry" ||
    eventType === "sandbox_enforced"
  ) {
    return theme.warn;
  }
  return theme.muted;
}
