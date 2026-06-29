import type { DatabaseSync } from "node:sqlite";

import type { TodoItem } from "../../tools/todo-session-store.js";
import { parseJsonValue, serializeJsonValue } from "./json.js";

interface SessionTodoRow {
  session_id: string;
  todos_json: string;
  updated_at: string;
}

export class SqliteSessionTodoRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public list(sessionId: string): TodoItem[] {
    const row = this.database
      .prepare("SELECT todos_json FROM session_todos WHERE session_id = ?")
      .get(sessionId) as Pick<SessionTodoRow, "todos_json"> | undefined;
    if (row === undefined) {
      return [];
    }
    return parseJsonValue<TodoItem[]>(row.todos_json);
  }

  public replace(sessionId: string, todos: TodoItem[]): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO session_todos (session_id, todos_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           todos_json = excluded.todos_json,
           updated_at = excluded.updated_at`
      )
      .run(sessionId, serializeJsonValue(todos), now);
  }

  public delete(sessionId: string): void {
    this.database.prepare("DELETE FROM session_todos WHERE session_id = ?").run(sessionId);
  }
}
