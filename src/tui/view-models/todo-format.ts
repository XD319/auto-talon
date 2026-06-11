import { gray, green, cyan, red } from "../ansi.js";
import { sanitizeTerminalText } from "../text-sanitize.js";
import type { TodoTraceItem, TodoTracePayload, TodoTraceStatus } from "../../types/trace.js";

export const MAX_VISIBLE_TODOS = 10;
const RECENT_COMPLETED_MS = 30_000;
const MAX_TODO_CONTENT_LENGTH = 72;

export function sortTodosForDisplay(todos: TodoTraceItem[]): TodoTraceItem[] {
  return [...todos];
}

export interface VisibleTodoSelection {
  overflowSummary: string | null;
  visible: TodoTraceItem[];
}

export function selectVisibleTodos(
  todos: TodoTraceItem[],
  options: { maxVisible?: number; now?: number } = {}
): VisibleTodoSelection {
  const maxVisible = options.maxVisible ?? MAX_VISIBLE_TODOS;
  const now = options.now ?? Date.now();
  const ordered = sortTodosForDisplay(todos);

  if (ordered.length <= maxVisible) {
    return { overflowSummary: null, visible: ordered };
  }

  const indexed = ordered.map((todo, index) => ({ index, todo }));
  indexed.sort((left, right) => {
    const priorityDelta = visibilityPriority(left.todo, now) - visibilityPriority(right.todo, now);
    return priorityDelta !== 0 ? priorityDelta : left.index - right.index;
  });

  const visibleIds = new Set(
    indexed
      .slice(0, maxVisible)
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.todo.id)
  );
  const visible = ordered.filter((todo) => visibleIds.has(todo.id));
  const hidden = ordered.filter((todo) => !visibleIds.has(todo.id));

  return {
    overflowSummary: formatOverflowSummary(hidden),
    visible
  };
}

export function estimateTodoPanelRows(todos: TodoTraceItem[], open: boolean): number {
  if (!open || todos.length === 0) {
    return 0;
  }
  const { overflowSummary, visible } = selectVisibleTodos(todos);
  return 1 + visible.length + (overflowSummary !== null ? 1 : 0);
}

export function formatTodoScrollbackCompact(snapshot: TodoTracePayload, elapsed?: string): string {
  const elapsedSuffix = elapsed !== undefined && elapsed.length > 0 ? ` ${elapsed}` : "";
  return `${gray("┊")} ${gray("☑")} todo updated  ${snapshot.doneCount}/${snapshot.totalCount} done${elapsedSuffix}\n`;
}

export function formatTodoActivityText(snapshot: TodoTracePayload): string {
  const { visible } = selectVisibleTodos(snapshot.todos);
  const parts = visible.slice(0, 3).map((todo) => `${todoStatusGlyph(todo.status)} ${truncateTodoContent(todo.content)}`);
  const suffix = visible.length > 3 ? " · ..." : "";
  return `Todos ${snapshot.doneCount}/${snapshot.totalCount}: ${parts.join(" · ")}${suffix}`;
}

export function formatTodoPanelTitle(snapshot: TodoTracePayload, open: boolean): string {
  const toggleLabel = open ? "Ctrl+T hide" : "Ctrl+T show";
  return `Tasks ${snapshot.doneCount}/${snapshot.totalCount}  |  ${toggleLabel}`;
}

export function formatTodoPanelLine(todo: TodoTraceItem): string {
  return `${todoStatusGlyphStyled(todo.status)} ${sanitizeTerminalText(truncateTodoContent(todo.content))}`;
}

export function todoStatusGlyph(status: TodoTraceStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◉";
    case "cancelled":
      return "⨯";
    default:
      return "○";
  }
}

function todoStatusGlyphStyled(status: TodoTraceStatus): string {
  const glyph = todoStatusGlyph(status);
  switch (status) {
    case "completed":
      return green(glyph);
    case "in_progress":
      return cyan(glyph);
    case "cancelled":
      return red(glyph);
    default:
      return gray(glyph);
  }
}

function visibilityPriority(todo: TodoTraceItem, now: number): number {
  if (todo.status === "completed") {
    const updatedAt = todo.statusUpdatedAt !== undefined ? Date.parse(todo.statusUpdatedAt) : Number.NaN;
    if (Number.isFinite(updatedAt) && now - updatedAt <= RECENT_COMPLETED_MS) {
      return 0;
    }
    return 4;
  }
  if (todo.status === "in_progress") {
    return 1;
  }
  if (todo.status === "pending") {
    return 2;
  }
  return 3;
}

function formatOverflowSummary(hidden: TodoTraceItem[]): string | null {
  if (hidden.length === 0) {
    return null;
  }

  const counts = {
    cancelled: 0,
    completed: 0,
    in_progress: 0,
    pending: 0
  };
  for (const todo of hidden) {
    counts[todo.status] += 1;
  }

  const parts: string[] = [];
  if (counts.in_progress > 0) {
    parts.push(`${counts.in_progress} in progress`);
  }
  if (counts.pending > 0) {
    parts.push(`${counts.pending} pending`);
  }
  if (counts.completed > 0) {
    parts.push(`${counts.completed} completed`);
  }
  if (counts.cancelled > 0) {
    parts.push(`${counts.cancelled} cancelled`);
  }

  return parts.length > 0 ? `... +${parts.join(", ")}` : null;
}

function truncateTodoContent(content: string): string {
  const compact = content.replace(/\s+/gu, " ").trim();
  return compact.length <= MAX_TODO_CONTENT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_TODO_CONTENT_LENGTH - 3)}...`;
}

export function toTodoTracePayload(todos: Array<{
  content: string;
  id: string;
  status: TodoTraceStatus;
  statusUpdatedAt?: string;
}>): TodoTracePayload {
  return {
    doneCount: todos.filter((todo) => todo.status === "completed").length,
    todos,
    totalCount: todos.length
  };
}
