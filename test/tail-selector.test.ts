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
    expect(tail.length).toBeGreaterThanOrEqual(4);
    expect(tail.length).toBeLessThan(messages.length);
  });
});
