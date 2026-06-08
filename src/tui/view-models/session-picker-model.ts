import type { SessionIndexEntry } from "../../types/index.js";
import type { ChatMessage } from "./chat-messages.js";

export const SESSION_PICKER_MAX_ENTRIES = 20;
export const SESSION_PREVIEW_MESSAGE_LIMIT = 5;

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
