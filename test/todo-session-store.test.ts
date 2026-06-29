import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";
import { TodoSessionStore } from "../src/tools/todo-session-store.js";

describe("todo session store persistence", () => {
  it("persists todos to sqlite and reloads them in a new store instance", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const store = new TodoSessionStore(storage.sessionTodos);
    store.update(
      "session-1",
      [
        { content: "Fix auth bug", id: "todo-1", status: "pending" },
        { content: "Add tests", id: "todo-2", status: "in_progress" }
      ],
      false
    );

    const reloaded = new TodoSessionStore(storage.sessionTodos);
    expect(reloaded.get("session-1")).toEqual([
      expect.objectContaining({ content: "Fix auth bug", id: "todo-1", status: "pending" }),
      expect.objectContaining({ content: "Add tests", id: "todo-2", status: "in_progress" })
    ]);
    storage.close();
  });

  it("drops stale ids during merge", () => {
    const store = new TodoSessionStore();
    store.update(
      "session-1",
      [{ content: "keep", id: "todo-1", status: "pending" }],
      false
    );
    const merged = store.update(
      "session-1",
      [{ content: "new", id: "todo-2", status: "pending" }],
      true
    );
    expect(merged.every((todo) => todo !== undefined)).toBe(true);
    expect(merged.map((todo) => todo.id)).toEqual(["todo-1", "todo-2"]);
  });
});
