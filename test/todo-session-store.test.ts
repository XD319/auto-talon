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

describe("todo session store consistency", () => {
  it("refreshes repository state written by another store before merging", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const first = new TodoSessionStore(storage.sessionTodos);
    const second = new TodoSessionStore(storage.sessionTodos);
    expect(first.get("session-shared")).toEqual([]);
    second.update(
      "session-shared",
      [{ content: "written second", id: "todo-second", status: "pending" }],
      false
    );
    first.update(
      "session-shared",
      [{ content: "written first", id: "todo-first", status: "pending" }],
      true
    );
    expect(storage.sessionTodos.list("session-shared").map((todo) => todo.id)).toEqual([
      "todo-second",
      "todo-first"
    ]);
    storage.close();
  });

  it("deduplicates ids and supports clearing the list", () => {
    const store = new TodoSessionStore();
    const replaced = store.update(
      "session-duplicates",
      [
        { content: "old", id: "same", status: "pending" },
        { content: "new", id: "same", status: "completed" }
      ],
      false
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ content: "new", id: "same", status: "completed" });
    expect(store.update("session-duplicates", [], false)).toEqual([]);
  });
});
