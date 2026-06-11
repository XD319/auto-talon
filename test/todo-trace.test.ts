import { describe, expect, it } from "vitest";

import { extractTodoSnapshotFromOutput, readTodoSnapshot } from "../src/presentation/todo-trace.js";

describe("todo trace", () => {
  it("extracts a todo snapshot from tool output", () => {
    const snapshot = extractTodoSnapshotFromOutput({
      merge: true,
      sessionKey: "session-1",
      todos: [
        { content: "Inspect repo", id: "todo-1", status: "pending" },
        { content: "Write tests", id: "todo-2", status: "in_progress", statusUpdatedAt: "2026-01-01T00:00:00.000Z" }
      ]
    });

    expect(snapshot).toEqual({
      doneCount: 0,
      totalCount: 2,
      todos: [
        { content: "Inspect repo", id: "todo-1", status: "pending" },
        {
          content: "Write tests",
          id: "todo-2",
          status: "in_progress",
          statusUpdatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    });
  });

  it("returns undefined for invalid output", () => {
    expect(extractTodoSnapshotFromOutput({ todos: [] })).toBeUndefined();
    expect(extractTodoSnapshotFromOutput("bad")).toBeUndefined();
  });

  it("reads todoSnapshot payloads from trace events", () => {
    const snapshot = readTodoSnapshot({
      doneCount: 1,
      totalCount: 2,
      todos: [
        { content: "Done task", id: "todo-1", status: "completed" },
        { content: "Next task", id: "todo-2", status: "pending" }
      ]
    });

    expect(snapshot?.doneCount).toBe(1);
    expect(snapshot?.todos.map((todo) => todo.content)).toEqual(["Done task", "Next task"]);
  });
});
