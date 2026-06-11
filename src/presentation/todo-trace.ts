import type { JsonValue } from "../types/index.js";
import type { TodoTraceItem, TodoTracePayload, TodoTraceStatus } from "../types/trace.js";

const TODO_STATUSES = new Set<TodoTraceStatus>(["pending", "in_progress", "completed", "cancelled"]);

export function extractTodoSnapshotFromOutput(output: JsonValue): TodoTracePayload | undefined {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return undefined;
  }

  const record = output as Record<string, unknown>;
  if (!Array.isArray(record.todos)) {
    return undefined;
  }

  const todos: TodoTraceItem[] = [];
  for (const item of record.todos) {
    const parsed = parseTodoTraceItem(item);
    if (parsed !== null) {
      todos.push(parsed);
    }
  }

  if (todos.length === 0) {
    return undefined;
  }

  return {
    doneCount: todos.filter((todo) => todo.status === "completed").length,
    todos,
    totalCount: todos.length
  };
}

export function readTodoSnapshot(value: unknown): TodoTracePayload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.todos)) {
    return null;
  }

  const todos: TodoTraceItem[] = [];
  for (const item of record.todos) {
    const parsed = parseTodoTraceItem(item);
    if (parsed !== null) {
      todos.push(parsed);
    }
  }

  if (todos.length === 0) {
    return null;
  }

  const doneCount =
    typeof record.doneCount === "number" && Number.isFinite(record.doneCount)
      ? record.doneCount
      : todos.filter((todo) => todo.status === "completed").length;
  const totalCount =
    typeof record.totalCount === "number" && Number.isFinite(record.totalCount)
      ? record.totalCount
      : todos.length;

  return { doneCount, todos, totalCount };
}

function parseTodoTraceItem(value: unknown): TodoTraceItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.content !== "string") {
    return null;
  }

  const status = record.status;
  if (typeof status !== "string" || !TODO_STATUSES.has(status as TodoTraceStatus)) {
    return null;
  }

  return {
    content: record.content,
    id: record.id,
    status: status as TodoTraceStatus,
    ...(typeof record.statusUpdatedAt === "string" ? { statusUpdatedAt: record.statusUpdatedAt } : {})
  };
}
