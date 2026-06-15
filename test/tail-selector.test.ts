import { describe, expect, it } from "vitest";

import { selectTailMessages } from "../src/runtime/context/tail-selector.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("tail-selector", () => {
  it("keeps at least tailMinMessages and respects token budget", () => {
    const messages: ConversationMessage[] = Array.from({ length: 12 }, (_, index) => ({
      content: `message-${index}-${"y".repeat(2_000)}`,
      role: index % 2 === 0 ? "user" : "assistant"
    }));
    const tail = selectTailMessages(messages, {
      tailMinMessages: 4,
      tailTokenBudget: 3_000
    });
    expect(tail.messages.length).toBeGreaterThanOrEqual(4);
    expect(tail.messages.length).toBeLessThan(messages.length);
  });

  it("protects the last N messages and keeps assistant tool call pairs intact", () => {
    const messages: ConversationMessage[] = [
      { content: "old", role: "user" },
      { content: "assistant asks tool", role: "assistant", toolCalls: [{ input: {}, reason: "read", toolCallId: "tc-1", toolName: "read_file" }] },
      { content: "tool result", role: "tool", toolCallId: "tc-1", toolName: "read_file" },
      { content: "latest user", role: "user" },
      { content: "latest assistant", role: "assistant" }
    ];
    const tail = selectTailMessages(messages, {
      protectLastN: 2,
      tailMinMessages: 1,
      tailTokenBudget: 1_000
    });
    expect(tail.messages.map((message) => message.content)).toContain("assistant asks tool");
    expect(tail.messages.map((message) => message.content)).toContain("tool result");
    expect(tail.messages.at(-2)?.content).toBe("latest user");
    expect(tail.messages.at(-1)?.content).toBe("latest assistant");
  });

  it("reports budget overflow when protected tail exceeds tailTokenBudget", () => {
    const messages: ConversationMessage[] = Array.from({ length: 6 }, (_, index) => ({
      content: `message-${index}-${"z".repeat(4_000)}`,
      role: index % 2 === 0 ? "user" : "assistant"
    }));
    const tail = selectTailMessages(messages, {
      protectLastN: 4,
      tailMinMessages: 4,
      tailTokenBudget: 1_000
    });
    expect(tail.budgetExceeded).toBe(true);
    expect(tail.usedTokens).toBeGreaterThan(1_000);
    expect(tail.messages.length).toBeGreaterThanOrEqual(4);
  });
});
