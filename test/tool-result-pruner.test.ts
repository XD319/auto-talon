import { describe, expect, it } from "vitest";

import {
  CLEARED_TOOL_RESULT_MARKER,
  pruneOldToolResults
} from "../src/runtime/context/tool-result-pruner.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("tool-result-pruner", () => {
  it("clears older tool results while keeping the latest groups", () => {
    const messages: ConversationMessage[] = [
      { content: "u1", role: "user" },
      { content: "a1", role: "assistant" },
      { content: "old-1", role: "tool", toolCallId: "tc-1", toolName: "read_file" },
      { content: "a2", role: "assistant" },
      { content: "old-2", role: "tool", toolCallId: "tc-2", toolName: "read_file" },
      { content: "a3", role: "assistant" },
      { content: "keep-3", role: "tool", toolCallId: "tc-3", toolName: "read_file" },
      { content: "a4", role: "assistant" },
      { content: "keep-4", role: "tool", toolCallId: "tc-4", toolName: "read_file" },
      { content: "a5", role: "assistant" },
      { content: "keep-5", role: "tool", toolCallId: "tc-5", toolName: "read_file" },
      { content: "a6", role: "assistant" },
      { content: "keep-6", role: "tool", toolCallId: "tc-6", toolName: "read_file" }
    ];
    const result = pruneOldToolResults(messages, 5);
    expect(result.prunedCount).toBe(1);
    expect(messages[2]?.content).toBe(CLEARED_TOOL_RESULT_MARKER);
    expect(messages.at(-1)?.content).toBe("keep-6");
  });
});
