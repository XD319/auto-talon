import { describe, expect, it } from "vitest";

import {
  reasoningContentForReplay,
  shouldReplayReasoningContent
} from "../src/providers/reasoning-content.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("reasoning content replay", () => {
  it("replays reasoning for assistant tool-call messages", () => {
    const message: ConversationMessage = {
      content: "Let me read the file.",
      reasoningContent: "Need to inspect README first.",
      role: "assistant",
      toolCalls: [
        {
          input: { path: "README.md" },
          reason: "read",
          toolCallId: "call-1",
          toolName: "read_file"
        }
      ]
    };

    expect(shouldReplayReasoningContent(message, [message], 0)).toBe(true);
    expect(reasoningContentForReplay(message, [message], 0)).toBe("Need to inspect README first.");
  });

  it("replays empty reasoning for tool-call messages when content was omitted", () => {
    const message: ConversationMessage = {
      content: "",
      role: "assistant",
      toolCalls: [
        {
          input: {},
          reason: "read",
          toolCallId: "call-1",
          toolName: "read_file"
        }
      ]
    };

    expect(reasoningContentForReplay(message, [message], 0)).toBe("");
  });

  it("replays reasoning on final assistant messages after tool calls", () => {
    const messages: ConversationMessage[] = [
      {
        content: "",
        reasoningContent: "Tool result received.",
        role: "assistant",
        toolCalls: [
          {
            input: {},
            reason: "read",
            toolCallId: "call-1",
            toolName: "read_file"
          }
        ]
      },
      {
        content: "ok",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file"
      },
      {
        content: "Here is the summary.",
        reasoningContent: "Summarize tool output.",
        role: "assistant"
      }
    ];

    expect(shouldReplayReasoningContent(messages[2]!, messages, 2)).toBe(true);
    expect(reasoningContentForReplay(messages[2]!, messages, 2)).toBe("Summarize tool output.");
  });

  it("does not replay reasoning for pure chat without tool calls", () => {
    const messages: ConversationMessage[] = [
      { content: "hello", role: "user" },
      {
        content: "hi",
        reasoningContent: "Simple greeting.",
        role: "assistant"
      },
      { content: "how are you?", role: "user" }
    ];

    expect(shouldReplayReasoningContent(messages[1]!, messages, 1)).toBe(false);
    expect(reasoningContentForReplay(messages[1]!, messages, 1)).toBeUndefined();
  });
});

describe("resolveProviderFinalText", () => {
  it("falls back to reasoningContent for empty final messages", async () => {
    const { resolveProviderFinalText } = await import("../src/providers/reasoning-content.js");
    expect(
      resolveProviderFinalText({
        kind: "final",
        message: "",
        reasoningContent: "summary body"
      })
    ).toBe("summary body");
  });
});
