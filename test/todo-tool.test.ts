import { describe, expect, it } from "vitest";

import { TodoSessionStore } from "../src/tools/todo-session-store.js";
import { TodoTool } from "../src/tools/todo-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("TodoTool", () => {
  it("replaces the list by default", async () => {
    const store = new TodoSessionStore();
    const tool = new TodoTool(store);
    const context = createContext("session-1");

    await tool.execute(
      tool.prepare({
        todos: [
          { content: "First", id: "todo-1", status: "pending" },
          { content: "Second", id: "todo-2", status: "pending" }
        ]
      }).preparedInput,
      context
    );

    const result = await tool.execute(
      tool.prepare({
        todos: [{ content: "Inspect repo", id: "todo-1", status: "in_progress" }]
      }).preparedInput,
      context
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const output = result.output as { todos: Array<{ id: string; status: string }> };
      expect(output.todos).toHaveLength(1);
      expect(output.todos[0]).toMatchObject({
        content: "Inspect repo",
        id: "todo-1",
        status: "in_progress"
      });
      expect(typeof output.todos[0]?.statusUpdatedAt).toBe("string");
    }
  });

  it("preserves insertion order when merging new todos", async () => {
    const store = new TodoSessionStore();
    const tool = new TodoTool(store);
    const context = createContext("session-3");

    await tool.execute(
      tool.prepare({
        todos: [{ content: "Second", id: "todo-2", status: "pending" }]
      }).preparedInput,
      context
    );
    await tool.execute(
      tool.prepare({
        merge: true,
        todos: [{ content: "First", id: "todo-1", status: "pending" }]
      }).preparedInput,
      context
    );

    expect(store.get("session-3").map((todo) => todo.id)).toEqual(["todo-2", "todo-1"]);
  });

  it("clears the list when every item is completed", async () => {
    const store = new TodoSessionStore();
    const tool = new TodoTool(store);
    const context = createContext("session-done");

    await tool.execute(
      tool.prepare({
        todos: [{ content: "First", id: "todo-1", status: "pending" }]
      }).preparedInput,
      context
    );
    const result = await tool.execute(
      tool.prepare({
        todos: [{ content: "First", id: "todo-1", status: "completed" }]
      }).preparedInput,
      context
    );

    expect(result.success).toBe(true);
    expect(store.get("session-done")).toEqual([]);
  });
});

function createContext(sessionId: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-1",
    taskMetadata: { sessionId },
    userId: "user-1",
    workspaceRoot: process.cwd()
  };
}

describe("TodoTool clearing", () => {
  it("accepts an empty replacement to clear session todos", async () => {
    const store = new TodoSessionStore();
    const tool = new TodoTool(store);
    const context = createContext("session-clear");
    await tool.execute(
      tool.prepare({ todos: [{ content: "remove me", id: "todo-1", status: "pending" }] }).preparedInput,
      context
    );
    const result = await tool.execute(tool.prepare({ todos: [] }).preparedInput, context);
    expect(result.success).toBe(true);
    expect(store.get("session-clear")).toEqual([]);
  });
});
