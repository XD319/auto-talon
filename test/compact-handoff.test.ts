import { describe, expect, it } from "vitest";

import {
  collectPreservedIndices,
  listDiscardedMessages
} from "../src/runtime/context/compact-handoff.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("compact handoff", () => {
  it("discards only unmatched duplicate user messages in order", () => {
    const allMessages: ConversationMessage[] = [
      { content: "same request", role: "user" },
      { content: "working", role: "assistant" },
      { content: "same request", role: "user" },
      { content: "done", role: "assistant" }
    ];
    const preservedMessages: ConversationMessage[] = [
      { content: "same request", role: "user" },
      { content: "done", role: "assistant" }
    ];
    const discarded = listDiscardedMessages(allMessages, preservedMessages);
    expect(discarded.map((message) => message.content)).toEqual(["working", "same request"]);
    expect(collectPreservedIndices(allMessages, preservedMessages)).toEqual(new Set([0, 3]));
  });
});
