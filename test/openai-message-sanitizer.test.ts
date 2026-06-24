import { describe, expect, it } from "vitest";

import { normalizeOpenAiCompatibleMessages } from "../src/providers/openai-message-sanitizer.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("normalizeOpenAiCompatibleMessages", () => {
  it("drops orphan tool messages without a preceding tool_calls assistant", () => {
    const messages: ConversationMessage[] = [
      { content: "hello", role: "user" },
      {
        content: "done",
        role: "assistant"
      },
      {
        content: "orphan",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file"
      }
    ];

    expect(normalizeOpenAiCompatibleMessages(messages)).toEqual([
      { content: "hello", role: "user" },
      { content: "done", role: "assistant" }
    ]);
  });

  it("removes duplicated trailing tool messages", () => {
    const messages: ConversationMessage[] = [
      { content: "read README", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          {
            input: { path: "README.md" },
            reason: "read",
            toolCallId: "call-1",
            toolName: "read_file"
          }
        ]
      },
      {
        content: "README",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file"
      },
      {
        content: "README",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file"
      }
    ];

    expect(normalizeOpenAiCompatibleMessages(messages)).toEqual([
      messages[0],
      messages[1],
      messages[2]
    ]);
  });

  it("strips tool_calls from assistant turns that have no tool results", () => {
    const messages: ConversationMessage[] = [
      { content: "read README", role: "user" },
      {
        content: "calling tool",
        role: "assistant",
        toolCalls: [
          {
            input: { path: "README.md" },
            reason: "read",
            toolCallId: "call-1",
            toolName: "read_file"
          }
        ]
      },
      { content: "next", role: "user" }
    ];

    expect(normalizeOpenAiCompatibleMessages(messages)).toEqual([
      { content: "read README", role: "user" },
      { content: "calling tool", role: "assistant" },
      { content: "next", role: "user" }
    ]);
  });
});
