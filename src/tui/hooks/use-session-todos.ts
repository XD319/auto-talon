import type { TodoItem } from "../../tools/todo-session-store.js";

export interface SessionTodosView {
  open: boolean;
  todos: TodoItem[];
}

export function useSessionTodos(input: {
  todoPanelOpen: boolean;
  sessionTodos: TodoItem[];
}): SessionTodosView {
  return {
    open: input.todoPanelOpen,
    todos: input.sessionTodos
  };
}
