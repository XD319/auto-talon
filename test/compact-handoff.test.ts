import { describe, expect, it } from "vitest";

import {
  buildSessionHandoffMessageContent,
  listDiscardedMessages
} from "../src/runtime/context/compact-handoff.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("compact handoff", () => {
  it("lists messages removed by compaction", () => {
    const all: ConversationMessage[] = [
      { content: "head", role: "user" },
      { content: "middle", role: "assistant" },
      { content: "tail", role: "user" }
    ];
    const preserved: ConversationMessage[] = [
      { content: "head", role: "user" },
      { content: "tail", role: "user" }
    ];
    expect(listDiscardedMessages(all, preserved)).toEqual([{ content: "middle", role: "assistant" }]);
  });

  it("builds continuation framing with role counts", () => {
    const content = buildSessionHandoffMessageContent({
      compactedMessages: [
        { content: "u1", role: "user" },
        { content: "a1", role: "assistant" },
        { content: "t1", role: "tool", toolCallId: "tc-1", toolName: "read_file" }
      ],
      summary: "goal=fix bugs"
    });
    expect(content).toContain("continued from a previous conversation");
    expect(content).toContain("Do not repeat completed work");
    expect(content).toContain("Compacted 3 earlier messages (user=1, assistant=1, tool=1)");
    expect(content).toContain("Session handoff:");
    expect(content).toContain("goal=fix bugs");
  });
});
