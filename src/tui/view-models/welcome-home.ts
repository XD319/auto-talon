import type { ChatSessionSummary } from "../session-store.js";

export interface WelcomeHomeEntry {
  detail: string;
  key: string;
  label: string;
  sessionId: string;
}

export interface WelcomeHomeViewModel {
  entries: WelcomeHomeEntry[];
  examples: string[];
  hint: string;
}

const MAX_RECENT_SESSIONS = 4;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function buildWelcomeHome(
  sessions: ChatSessionSummary[],
  currentSessionId: string,
  options: { now?: Date } = {}
): WelcomeHomeViewModel {
  const now = options.now ?? new Date();
  const entries = sessions
    .filter((session) => session.id !== currentSessionId)
    .slice(0, MAX_RECENT_SESSIONS)
    .map((session) => ({
      detail: formatSessionDetail(session, now),
      key: `session:${session.id}`,
      label: session.label,
      sessionId: session.id
    }));
  return {
    entries,
    examples:
      entries.length === 0
        ? [
            "Explain this project and point me to the entrypoints.",
            "Fix the failing test and verify the change.",
            "Turn this task into a small implementation plan."
          ]
        : [],
    hint:
      entries.length > 0
        ? "Type a request below, or use Up/Down and Enter to resume a conversation."
        : "Type a request below to start."
  };
}

function formatSessionDetail(session: ChatSessionSummary, now: Date): string {
  const updated = formatSessionUpdatedAt(session.updatedAt, now);
  if (session.preview === null || session.preview === session.label) {
    return updated;
  }
  return `${updated} - ${session.preview}`;
}

function formatSessionUpdatedAt(value: string, now: Date): string {
  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.getTime())) {
    return "Updated recently";
  }
  const elapsedMs = now.getTime() - updatedAt.getTime();
  if (elapsedMs < 0) {
    return `Updated ${formatSessionDate(updatedAt, now)}`;
  }
  if (elapsedMs < MINUTE_MS) {
    return "Updated just now";
  }
  if (elapsedMs < HOUR_MS) {
    return `Updated ${Math.floor(elapsedMs / MINUTE_MS)}m ago`;
  }
  if (elapsedMs < DAY_MS) {
    return `Updated ${Math.floor(elapsedMs / HOUR_MS)}h ago`;
  }
  if (elapsedMs < 2 * DAY_MS) {
    return "Updated yesterday";
  }
  if (elapsedMs < 7 * DAY_MS) {
    return `Updated ${Math.floor(elapsedMs / DAY_MS)}d ago`;
  }
  return `Updated ${formatSessionDate(updatedAt, now)}`;
}

function formatSessionDate(updatedAt: Date, now: Date): string {
  return updatedAt.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    ...(updatedAt.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {})
  });
}
