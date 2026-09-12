export type InteractionMode = "agent" | "plan" | "acceptEdits";

export type SlashIntent =
  | { kind: "new" }
  | { kind: "clear"; title?: string }
  | { kind: "sessions" }
  | { kind: "mode"; mode: InteractionMode }
  | { kind: "stop" }
  | { kind: "diff" }
  | { kind: "inbox" }
  | { kind: "memory" }
  | { kind: "schedule" }
  | { kind: "todos" }
  | { kind: "next" }
  | { kind: "compact" }
  | { kind: "help" }
  | { kind: "sandbox" }
  | { kind: "model"; selection?: string }
  | { kind: "today" }
  | { kind: "unknown" };

export const SLASH_COMMANDS: Array<{ insert: string; label: string }> = [
  { insert: "/new", label: "Start a new session" },
  { insert: "/clear", label: "Save and start a new session" },
  { insert: "/sessions", label: "Focus session list" },
  { insert: "/mode plan", label: "Read-only plan mode" },
  { insert: "/mode agent", label: "Agent mode" },
  { insert: "/mode acceptEdits", label: "Accept edits mode" },
  { insert: "/model", label: "Show models" },
  { insert: "/stop", label: "Stop current task" },
  { insert: "/compact", label: "Request compaction" },
  { insert: "/diff", label: "Show file changes" },
  { insert: "/inbox", label: "Open inbox" },
  { insert: "/memory", label: "Open memory" },
  { insert: "/schedule", label: "Open schedules" },
  { insert: "/todos", label: "Open session todos" },
  { insert: "/next", label: "Open next actions" },
  { insert: "/today", label: "Today summary" },
  { insert: "/sandbox", label: "Show workspace" },
  { insert: "/help", label: "Command help" }
];

export function parseSlashIntent(text: string): SlashIntent | null {
  const value = text.trim();
  if (!value.startsWith("/")) {
    return null;
  }
  if (value === "/new") {
    return { kind: "new" };
  }
  if (value === "/clear") {
    return { kind: "clear" };
  }
  if (value.startsWith("/clear ")) {
    const title = value.slice("/clear ".length).trim();
    return title.length > 0 ? { kind: "clear", title } : { kind: "clear" };
  }
  if (value === "/sessions") {
    return { kind: "sessions" };
  }
  if (value.startsWith("/mode ")) {
    const next = value.slice(6).trim();
    if (next === "agent" || next === "plan" || next === "acceptEdits") {
      return { kind: "mode", mode: next };
    }
    return { kind: "unknown" };
  }
  if (value === "/stop") {
    return { kind: "stop" };
  }
  if (value === "/diff") {
    return { kind: "diff" };
  }
  if (value === "/inbox") {
    return { kind: "inbox" };
  }
  if (value === "/memory") {
    return { kind: "memory" };
  }
  if (value === "/schedule") {
    return { kind: "schedule" };
  }
  if (value === "/todos") {
    return { kind: "todos" };
  }
  if (value === "/next") {
    return { kind: "next" };
  }
  if (value === "/compact") {
    return { kind: "compact" };
  }
  if (value === "/help") {
    return { kind: "help" };
  }
  if (value === "/sandbox") {
    return { kind: "sandbox" };
  }
  if (value === "/today") {
    return { kind: "today" };
  }
  if (value === "/model") {
    return { kind: "model" };
  }
  if (value.startsWith("/model ")) {
    const selection = value.slice(7).trim();
    return selection.length > 0 ? { kind: "model", selection } : { kind: "model" };
  }
  return { kind: "unknown" };
}

export function matchingSlashCommands(draft: string): Array<{ insert: string; label: string }> {
  if (!draft.startsWith("/")) {
    return [];
  }
  const needle = draft.trim();
  return SLASH_COMMANDS.filter(
    (item) => item.insert.startsWith(needle) || item.label.toLowerCase().includes(draft.slice(1).toLowerCase())
  );
}
