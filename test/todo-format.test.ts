import { describe, expect, it } from "vitest";

import {
  formatTodoScrollbackCompact,
  selectVisibleTodos,
  sortTodosForDisplay,
  toTodoTracePayload
} from "../src/tui/view-models/todo-format.js";
import type { TodoTraceItem } from "../src/types/trace.js";

describe("todo format", () => {
  it("preserves insertion order for display", () => {
    const todos: TodoTraceItem[] = [
      { content: "Second", id: "todo-2", status: "pending" },
      { content: "First", id: "todo-1", status: "completed" }
    ];

    expect(sortTodosForDisplay(todos).map((todo) => todo.id)).toEqual(["todo-2", "todo-1"]);
  });

  it("formats compact scrollback lines", () => {
    const text = formatTodoScrollbackCompact(
      toTodoTracePayload([
        { content: "A", id: "1", status: "completed" },
        { content: "B", id: "2", status: "pending" }
      ]),
      "0.2s"
    );

    expect(text).toContain("todo updated");
    expect(text).toContain("1/2 done");
    expect(text).toContain("0.2s");
  });

  it("prioritizes visible todos when the list exceeds the panel limit", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z");
    const todos: TodoTraceItem[] = Array.from({ length: 12 }, (_, index) => ({
      content: `Task ${index + 1}`,
      id: `todo-${index + 1}`,
      status: index === 0 ? "in_progress" : index < 11 ? "pending" : "completed",
      ...(index === 11 ? { statusUpdatedAt: "2026-01-01T00:00:50.000Z" } : {})
    }));

    const { overflowSummary, visible } = selectVisibleTodos(todos, { now });
    expect(visible).toHaveLength(10);
    expect(visible[0]?.status).toBe("in_progress");
    expect(visible.some((todo) => todo.id === "todo-12")).toBe(true);
    expect(overflowSummary).toContain("pending");
  });
});
