import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/providers/provider-error.js";
import {
  dropOldestNonSystemMessages,
  isContextOverflowProviderError
} from "../src/runtime/context/reactive-compact.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("reactive compact", () => {
  it("detects context overflow provider errors", () => {
    expect(
      isContextOverflowProviderError(
        new ProviderError({
          category: "invalid_request",
          message: "prompt is too long for the model context window",
          providerName: "openai"
        })
      )
    ).toBe(true);
    expect(
      isContextOverflowProviderError(
        new ProviderError({
          category: "invalid_request",
          message: "bad request",
          providerName: "openai",
          statusCode: 413
        })
      )
    ).toBe(true);
  });

  it("drops the oldest non-system message", () => {
    const messages: ConversationMessage[] = [
      { content: "system", role: "system" },
      { content: "old user", role: "user" },
      { content: "new user", role: "user" }
    ];
    expect(dropOldestNonSystemMessages(messages)).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["system", "new user"]);
  });
});

describe("reactive compact current request", () => {
  it("never drops the latest user request", () => {
    const messages: ConversationMessage[] = [
      { content: "system", role: "system" },
      { content: "current request", role: "user" }
    ];
    expect(dropOldestNonSystemMessages(messages)).toBe(0);
    expect(messages.at(-1)?.content).toBe("current request");
  });

  it("drops compact handoff system messages while preserving pinned todos", () => {
    const messages: ConversationMessage[] = [
      {
        content: "This session is being continued from a previous conversation.\nSession handoff:\ngoal=test",
        metadata: { sourceType: "compact_handoff" },
        role: "system"
      },
      {
        content: "Session todo list\n- [pending] t1: do work",
        metadata: { pinned: true, sourceType: "session_todos" },
        role: "system"
      },
      { content: "old user", role: "user" },
      { content: "current request", role: "user" }
    ];
    expect(dropOldestNonSystemMessages(messages)).toBe(1);
    expect(messages.map((message) => message.metadata?.sourceType)).toEqual([
      "session_todos",
      undefined,
      undefined
    ]);
    expect(dropOldestNonSystemMessages(messages)).toBe(1);
    expect(messages.map((message) => message.metadata?.sourceType)).toEqual(["session_todos", undefined]);
    expect(messages.at(-1)?.content).toBe("current request");
  });

  it("does not drop pinned todos when only protected system messages remain", () => {
    const messages: ConversationMessage[] = [
      {
        content: "Session todo list\n- [pending] t1: do work",
        metadata: { pinned: true, sourceType: "session_todos" },
        role: "system"
      },
      { content: "current request", role: "user" }
    ];
    expect(dropOldestNonSystemMessages(messages)).toBe(0);
    expect(messages).toHaveLength(2);
  });
});
