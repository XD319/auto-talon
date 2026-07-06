import type { SqliteSessionTodoRepository } from "../storage/repositories/session-todo-repository.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export const MAX_TODO_ITEMS = 100;

export interface TodoItem {
  content: string;
  id: string;
  status: TodoStatus;
  statusUpdatedAt?: string;
}

export function isActiveTodoStatus(status: TodoStatus): boolean {
  return status === "pending" || status === "in_progress";
}

export function filterActiveTodos(todos: TodoItem[]): TodoItem[] {
  return todos.filter((todo) => isActiveTodoStatus(todo.status));
}

export class TodoSessionStore {
  private readonly todosBySession = new Map<string, TodoItem[]>();

  public constructor(private readonly repository?: SqliteSessionTodoRepository) {}

  public get(sessionKey: string): TodoItem[] {
    const todos =
      this.repository !== undefined
        ? this.repository.list(sessionKey)
        : (this.todosBySession.get(sessionKey) ?? []);
    return cloneTodos(todos);
  }

  public update(sessionKey: string, todos: TodoItem[], merge: boolean): TodoItem[] {
    const now = new Date().toISOString();
    const normalized = dedupeTodos(todos);
    const existing = merge ? this.get(sessionKey) : [];
    const next = finalizeSessionTodos(
      merge
        ? mergeTodos(existing, normalized, now)
        : normalized.map((todo) => ({
            ...todo,
            statusUpdatedAt: now
          }))
    );
    this.persist(sessionKey, next);
    return cloneTodos(next);
  }

  public preload(sessionKey: string): void {
    void this.get(sessionKey);
  }

  private persist(sessionKey: string, todos: TodoItem[]): void {
    const snapshot = cloneTodos(todos);
    this.todosBySession.set(sessionKey, snapshot);
    this.repository?.replace(sessionKey, snapshot);
  }
}

function cloneTodos(todos: TodoItem[]): TodoItem[] {
  return todos.map((todo) => ({ ...todo }));
}

function dedupeTodos(todos: TodoItem[]): TodoItem[] {
  const byId = new Map<string, TodoItem>();
  const order: string[] = [];
  for (const todo of todos) {
    if (!byId.has(todo.id)) {
      order.push(todo.id);
    }
    byId.set(todo.id, { ...todo });
  }
  return order.map((id) => byId.get(id)!).filter(Boolean);
}

function finalizeSessionTodos(todos: TodoItem[]): TodoItem[] {
  return filterActiveTodos(todos).length > 0 ? todos : [];
}

function mergeTodos(
  existing: TodoItem[],
  updates: TodoItem[],
  now: string
): TodoItem[] {
  const byId = new Map(existing.map((todo) => [todo.id, todo]));
  const order = [...new Set(existing.map((todo) => todo.id))];
  for (const todo of updates) {
    const previous = byId.get(todo.id);
    if (previous === undefined) {
      order.push(todo.id);
    }
    byId.set(todo.id, {
      ...todo,
      statusUpdatedAt:
        previous !== undefined && previous.status === todo.status
          ? (previous.statusUpdatedAt ?? now)
          : now
    });
  }
  return order
    .map((id) => byId.get(id))
    .filter((todo): todo is TodoItem => todo !== undefined);
}

export function resolveTodoSessionKey(context: {
  taskId: string;
  taskMetadata?: Record<string, unknown>;
}): string {
  const sessionId = context.taskMetadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : context.taskId;
}
