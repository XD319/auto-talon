import type { SqliteSessionTodoRepository } from "../storage/repositories/session-todo-repository.js";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  content: string;
  id: string;
  status: TodoStatus;
  statusUpdatedAt?: string;
}

export class TodoSessionStore {
  private readonly todosBySession = new Map<string, TodoItem[]>();

  public constructor(private readonly repository?: SqliteSessionTodoRepository) {}

  public get(sessionKey: string): TodoItem[] {
    this.ensureLoaded(sessionKey);
    return [...(this.todosBySession.get(sessionKey) ?? [])];
  }

  public update(sessionKey: string, todos: TodoItem[], merge: boolean): TodoItem[] {
    const now = new Date().toISOString();
    const normalized = todos.map((todo) => ({ ...todo }));

    if (!merge) {
      const next = normalized.map((todo) => ({
        ...todo,
        statusUpdatedAt: now
      }));
      this.persist(sessionKey, next);
      return this.get(sessionKey);
    }

    this.ensureLoaded(sessionKey);
    const existing = this.get(sessionKey);
    const byId = new Map(existing.map((todo) => [todo.id, todo]));
    const order = existing.map((todo) => todo.id);

    for (const todo of normalized) {
      const previous = byId.get(todo.id);
      const statusUpdatedAt =
        previous !== undefined && previous.status === todo.status
          ? (previous.statusUpdatedAt ?? now)
          : now;
      if (previous === undefined) {
        order.push(todo.id);
      }
      byId.set(todo.id, {
        ...todo,
        statusUpdatedAt
      });
    }

    const next = order
      .map((id) => byId.get(id))
      .filter((todo): todo is TodoItem => todo !== undefined);
    this.persist(sessionKey, next);
    return this.get(sessionKey);
  }

  public preload(sessionKey: string): void {
    this.ensureLoaded(sessionKey);
  }

  private ensureLoaded(sessionKey: string): void {
    if (this.todosBySession.has(sessionKey) || this.repository === undefined) {
      return;
    }
    this.todosBySession.set(sessionKey, this.repository.list(sessionKey));
  }

  private persist(sessionKey: string, todos: TodoItem[]): void {
    this.todosBySession.set(sessionKey, todos);
    this.repository?.replace(sessionKey, todos);
  }
}

export function resolveTodoSessionKey(context: {
  taskId: string;
  taskMetadata?: Record<string, unknown>;
}): string {
  const sessionId = context.taskMetadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : context.taskId;
}
