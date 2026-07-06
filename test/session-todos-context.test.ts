import { describe, expect, it } from "vitest";

import {
  SESSION_TODOS_SOURCE_TYPE,
  buildSessionTodosMessage,
  syncSessionTodosMessage
} from "../src/runtime/context/session-todos.js";
import { TodoSessionStore } from "../src/tools/todo-session-store.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("session todos context", () => {
  it("builds a pinned system message from todo items", () => {
    const message = buildSessionTodosMessage([
      { content: "Fix auth bug", id: "todo-1", status: "pending" }
    ]);
    expect(message?.role).toBe("system");
    expect(message?.metadata?.sourceType).toBe(SESSION_TODOS_SOURCE_TYPE);
    expect(message?.content).toContain("[pending] todo-1: Fix auth bug");
  });

  it("syncs todos into messages after the first system prompt", () => {
    const store = new TodoSessionStore();
    store.update(
      "session-1",
      [{ content: "Ship fix", id: "todo-1", status: "in_progress" }],
      false
    );
    const messages: ConversationMessage[] = [
      { content: "system prompt", role: "system" },
      { content: "user input", role: "user" }
    ];
    const injected = syncSessionTodosMessage(messages, store, "session-1");
    expect(injected).not.toBeNull();
    expect(messages[1]?.metadata?.sourceType).toBe(SESSION_TODOS_SOURCE_TYPE);
    expect(messages[1]?.content).toContain("Ship fix");
    expect(messages[2]?.role).toBe("user");
  });

  it("replaces an existing session todo message on re-sync", () => {
    const store = new TodoSessionStore();
    const messages: ConversationMessage[] = [{ content: "system prompt", role: "system" }];
    syncSessionTodosMessage(
      messages,
      store,
      "session-1"
    );
    store.update(
      "session-1",
      [{ content: "Updated item", id: "todo-2", status: "pending" }],
      false
    );
    syncSessionTodosMessage(messages, store, "session-1");
    const todoMessages = messages.filter(
      (message) => message.metadata?.sourceType === SESSION_TODOS_SOURCE_TYPE
    );
    expect(todoMessages).toHaveLength(1);
    expect(todoMessages[0]?.content).toContain("Updated item");
  });
});

describe("session todos active context", () => {
  it("does not pin completed or cancelled items", () => {
    expect(
      buildSessionTodosMessage([
        { content: "done", id: "done", status: "completed" },
        { content: "cancelled", id: "cancelled", status: "cancelled" }
      ])
    ).toBeNull();
  });

  it("includes active todos up to the shared store limit", () => {
    const todos = Array.from({ length: 60 }, (_, index) => ({
      content: `task-${index + 1}`,
      id: `todo-${index + 1}`,
      status: "pending" as const
    }));
    const message = buildSessionTodosMessage(todos);
    expect(message?.content).toContain("todo-60: task-60");
    expect(message?.content).not.toContain("additional unfinished item(s) omitted");
  });
});
