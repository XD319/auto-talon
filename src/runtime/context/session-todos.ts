import type { ConversationMessage } from "../../types/index.js";
import type { TodoItem, TodoSessionStore } from "../../tools/todo-session-store.js";
import { resolveTodoSessionKey } from "../../tools/todo-session-store.js";

export const SESSION_TODOS_SOURCE_TYPE = "session_todos";

const STATUS_LABELS: Record<TodoItem["status"], string> = {
  cancelled: "cancelled",
  completed: "completed",
  in_progress: "in_progress",
  pending: "pending"
};

export function isSessionTodosMessage(message: ConversationMessage): boolean {
  return (
    message.role === "system" &&
    message.metadata?.sourceType === SESSION_TODOS_SOURCE_TYPE &&
    message.metadata?.pinned === true
  );
}

export function buildSessionTodosMessage(todos: TodoItem[]): ConversationMessage | null {
  if (todos.length === 0) {
    return null;
  }

  const lines = todos.map(
    (todo) => `- [${STATUS_LABELS[todo.status]}] ${todo.id}: ${todo.content}`
  );

  return {
    content: [
      "Session todo list (authoritative working checklist). Continue unfinished items before rediscovering work.",
      ...lines
    ].join("\n"),
    metadata: {
      pinned: true,
      privacyLevel: "internal",
      retentionKind: "session",
      sourceType: SESSION_TODOS_SOURCE_TYPE
    },
    role: "system"
  };
}

export function syncSessionTodosMessage(
  messages: ConversationMessage[],
  store: TodoSessionStore | undefined,
  sessionKey: string | null
): ConversationMessage | null {
  const withoutTodos = messages.filter((message) => !isSessionTodosMessage(message));
  messages.length = 0;
  messages.push(...withoutTodos);

  if (store === undefined || sessionKey === null || sessionKey.length === 0) {
    return null;
  }

  const todos = store.get(sessionKey);
  const todoMessage = buildSessionTodosMessage(todos);
  if (todoMessage === null) {
    return null;
  }

  const initialSystemIndex = messages.findIndex(
    (message) =>
      message.role === "system" &&
      message.metadata?.sourceType !== SESSION_TODOS_SOURCE_TYPE
  );
  const insertAt = initialSystemIndex >= 0 ? initialSystemIndex + 1 : 0;
  messages.splice(insertAt, 0, todoMessage);
  return todoMessage;
}

export function resolveTaskTodoSessionKey(task: { sessionId?: string | null; taskId: string }): string | null {
  if (typeof task.sessionId === "string" && task.sessionId.length > 0) {
    return task.sessionId;
  }
  return task.taskId.length > 0 ? task.taskId : null;
}

export function resolveTodoSessionKeyFromTaskMetadata(input: {
  sessionId?: string | null;
  taskId: string;
  taskMetadata?: Record<string, unknown>;
}): string {
  return resolveTodoSessionKey({
    taskId: input.taskId,
    taskMetadata: {
      ...input.taskMetadata,
      ...(input.sessionId !== null && input.sessionId !== undefined
        ? { sessionId: input.sessionId }
        : {})
    }
  });
}
