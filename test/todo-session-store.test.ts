import { describe, expect, it } from "vitest";

import { TodoSessionStore } from "../src/tools/todo-session-store.js";

describe("todo session store", () => {
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
