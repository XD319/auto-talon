import type { SessionIndexEntry } from "../../types/index.js";
import type { ChatMessage } from "./chat-messages.js";

export const SESSION_PICKER_MAX_ENTRIES = 20;
export const SESSION_PICKER_VISIBLE_ROWS = 12;
export const SESSION_PREVIEW_MESSAGE_LIMIT = 5;

export interface PickerViewport {
  end: number;
  start: number;
  total: number;
  visibleEntries: SessionIndexEntry[];
}

export function computePickerViewport(
  entries: SessionIndexEntry[],
  selectedIndex: number,
  visibleRows = SESSION_PICKER_VISIBLE_ROWS
): PickerViewport {
  const total = entries.length;
  if (total === 0) {
    return { end: 0, start: 0, total: 0, visibleEntries: [] };
  }
  if (total <= visibleRows) {
    return { end: total, start: 0, total, visibleEntries: entries };
  }
  const clampedIndex = clampPickerIndex(selectedIndex, total);
  const maxStart = total - visibleRows;
  const centeredStart = clampedIndex - Math.floor(visibleRows / 2);
  const start = Math.max(0, Math.min(centeredStart, maxStart));
  const end = start + visibleRows;
  return {
    end,
    start,
    total,
    visibleEntries: entries.slice(start, end)
  };
}

export function filterSessionIndexEntries(
  entries: SessionIndexEntry[],
  filter: string
): SessionIndexEntry[] {
  const normalized = filter.trim().toLowerCase();
  if (normalized.length === 0) {
    return entries.slice(0, SESSION_PICKER_MAX_ENTRIES);
  }
  return entries
    .filter((entry) => matchesSessionFilter(entry, normalized))
    .slice(0, SESSION_PICKER_MAX_ENTRIES);
}

export function matchesSessionFilter(entry: SessionIndexEntry, normalizedFilter: string): boolean {
  return (
    entry.sessionId.toLowerCase().startsWith(normalizedFilter) ||
    entry.title.toLowerCase().includes(normalizedFilter) ||
    (entry.preview ?? "").toLowerCase().includes(normalizedFilter)
  );
}

export function clampPickerIndex(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

export function pickerSessionAtIndex(entries: SessionIndexEntry[], index: number): string | null {
  if (entries.length === 0) {
    return null;
  }
  return entries[clampPickerIndex(index, entries.length)]?.sessionId ?? null;
}

export function pickerIndexForSession(entries: SessionIndexEntry[], sessionId: string | null): number {
  if (sessionId === null || entries.length === 0) {
    return 0;
  }
  const index = entries.findIndex((entry) => entry.sessionId === sessionId);
  return index === -1 ? 0 : index;
}

export function reconcilePickerSelection(
  entries: SessionIndexEntry[],
  selectedSessionId: string | null
): { index: number; sessionId: string | null } {
  if (entries.length === 0) {
    return { index: 0, sessionId: null };
  }
  const index = selectedSessionId === null ? -1 : entries.findIndex((entry) => entry.sessionId === selectedSessionId);
  if (index === -1) {
    return { index: 0, sessionId: entries[0]?.sessionId ?? null };
  }
  return { index, sessionId: selectedSessionId };
}

export function movePickerSessionId(
  entries: SessionIndexEntry[],
  selectedSessionId: string | null,
  delta: -1 | 1
): string | null {
  if (entries.length === 0) {
    return null;
  }
  const currentIndex = pickerIndexForSession(entries, selectedSessionId);
  const nextIndex = clampPickerIndex(currentIndex + delta, entries.length);
  return entries[nextIndex]?.sessionId ?? null;
}

export function extractPreviewMessages(
  messages: ChatMessage[],
  limit = SESSION_PREVIEW_MESSAGE_LIMIT
): ChatMessage[] {
  return messages.filter((message) => message.kind === "user" || message.kind === "agent").slice(-limit);
}

export function formatPreviewLine(message: ChatMessage): string {
  const prefix = message.kind === "user" ? "You" : "AutoTalon";
  const text = "text" in message && typeof message.text === "string" ? message.text : "";
  const normalized = text.replace(/\s+/gu, " ").trim();
  const clipped = normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
  return `${prefix}: ${clipped}`;
}
