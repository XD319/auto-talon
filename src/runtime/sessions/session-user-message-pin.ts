import type { SessionMessageRecord } from "../../types/index.js";

const DEFAULT_MAX_MESSAGES = 20;
const DEFAULT_MAX_LENGTH = 500;

export function extractUserMessageText(record: SessionMessageRecord): string | null {
  if (record.kind !== "user") {
    return null;
  }
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : null;
}

export function pinUserMessagesFromRecords(
  records: SessionMessageRecord[],
  options: { maxLength?: number; maxMessages?: number } = {}
): string[] {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const pinned: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const text = extractUserMessageText(record);
    if (text === null) {
      continue;
    }
    const compact = truncateText(text, maxLength);
    if (compact.length === 0 || seen.has(compact)) {
      continue;
    }
    seen.add(compact);
    pinned.push(compact);
  }
  return pinned.slice(-maxMessages);
}

function truncateText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
