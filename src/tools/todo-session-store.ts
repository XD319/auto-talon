export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  content: string;
  id: string;
  status: TodoStatus;
}

export class TodoSessionStore {
  private readonly todosBySession = new Map<string, TodoItem[]>();

  public get(sessionKey: string): TodoItem[] {
    return [...(this.todosBySession.get(sessionKey) ?? [])];
  }

  public update(sessionKey: string, todos: TodoItem[], merge: boolean): TodoItem[] {
    const normalized = todos.map((todo) => ({ ...todo }));
    if (!merge) {
      this.todosBySession.set(sessionKey, normalized);
      return this.get(sessionKey);
    }

    const existing = this.get(sessionKey);
    const merged = new Map(existing.map((todo) => [todo.id, todo]));
    for (const todo of normalized) {
      merged.set(todo.id, todo);
    }
    const next = [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
    this.todosBySession.set(sessionKey, next);
    return this.get(sessionKey);
  }
}

export function resolveTodoSessionKey(context: {
  taskId: string;
  taskMetadata?: Record<string, unknown>;
}): string {
  const sessionId = context.taskMetadata?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : context.taskId;
}
