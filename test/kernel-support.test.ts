import { describe, expect, it } from "vitest";

import {
  findLastAssistantToolCallsResponse,
  historyHasSuccessfulWrite,
  sanitizeToolCallPairing
} from "../src/runtime/kernel-support.js";
import type { ConversationMessage, ProviderToolCall } from "../src/types/index.js";

function toolResultMessage(toolName: string, content: string): ConversationMessage {
  return {
    content,
    metadata: {
      privacyLevel: "internal",
      retentionKind: "session",
      sourceType: "tool_result"
    },
    role: "tool",
    toolCallId: `call-${toolName}`,
    toolName
  };
}

function assistantMessage(content: string): ConversationMessage {
  return {
    content,
    metadata: {
      privacyLevel: "internal",
      retentionKind: "session",
      sourceType: "assistant_message"
    },
    role: "assistant"
  };
}

const isWriteTool = (toolName: string): boolean => toolName.includes("write");

describe("historyHasSuccessfulWrite", () => {
  it("returns false when message history is empty", () => {
    expect(historyHasSuccessfulWrite([], isWriteTool)).toBe(false);
  });

  it("returns false when there are no tool-role messages", () => {
    const messages: ConversationMessage[] = [
      assistantMessage("hello"),
      assistantMessage("world")
    ];
    expect(historyHasSuccessfulWrite(messages, isWriteTool)).toBe(false);
  });

  it("ignores tool results from non-write tools", () => {
    const messages = [
      toolResultMessage("read_file", JSON.stringify({ path: "a.txt", bytes: 10 }))
    ];
    expect(historyHasSuccessfulWrite(messages, isWriteTool)).toBe(false);
  });

  it("returns true when a write tool emitted a non-error payload", () => {
    const messages = [
      toolResultMessage("read_file", JSON.stringify({ path: "a.txt" })),
      toolResultMessage("write_file", JSON.stringify({ path: "b.txt", bytesWritten: 42 }))
    ];
    expect(historyHasSuccessfulWrite(messages, isWriteTool)).toBe(true);
  });

  it("treats the canonical failure envelope as not-successful", () => {
    const failureEnvelope = JSON.stringify({
      error: "Permission denied",
      errorCode: "filesystem_permission_denied",
      recoverable: true
    });
    const messages = [toolResultMessage("write_file", failureEnvelope)];
    expect(historyHasSuccessfulWrite(messages, isWriteTool)).toBe(false);
  });

  it("returns true when at least one of several write attempts succeeded", () => {
    const failureEnvelope = JSON.stringify({
      error: "boom",
      errorCode: "io_error",
      recoverable: true
    });
    const messages = [
      toolResultMessage("write_file", failureEnvelope),
      toolResultMessage("write_file", JSON.stringify({ path: "ok.txt", bytesWritten: 4 }))
    ];
    expect(historyHasSuccessfulWrite(messages, isWriteTool)).toBe(true);
  });

  it("does not treat plain non-JSON write payloads as failures", () => {
    const messages = [toolResultMessage("write_file", "written 12 bytes to b.txt")];
    expect(historyHasSuccessfulWrite(messages, isWriteTool)).toBe(true);
  });

  it("treats empty or null payloads as inconclusive (no proof of write)", () => {
    expect(historyHasSuccessfulWrite([toolResultMessage("write_file", "")], isWriteTool)).toBe(false);
    expect(historyHasSuccessfulWrite([toolResultMessage("write_file", "null")], isWriteTool)).toBe(false);
  });
});

function assistantToolCallsMessage(
  toolCalls: ProviderToolCall[],
  content = ""
): ConversationMessage {
  return {
    content,
    role: "assistant",
    toolCalls
  };
}

describe("sanitizeToolCallPairing", () => {
  it("inserts placeholder tool results when no tool results exist yet", () => {
    const messages: ConversationMessage[] = [
      assistantToolCallsMessage([
        {
          input: { query: "a" },
          reason: "search",
          toolCallId: "call-a",
          toolName: "web_search"
        },
        {
          input: { query: "b" },
          reason: "search",
          toolCallId: "call-b",
          toolName: "web_search"
        }
      ])
    ];

    const result = sanitizeToolCallPairing(messages);
    expect(result.insertedCount).toBe(2);
    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("tool");
    expect(messages[2]?.role).toBe("tool");
    expect(messages[1]?.content).toContain("tool_result_missing");
    expect(messages[2]?.content).toContain("tool_result_missing");
  });

  it("leaves already-paired assistant and tool messages unchanged", () => {
    const messages: ConversationMessage[] = [
      assistantToolCallsMessage([
        {
          input: { query: "a" },
          reason: "search",
          toolCallId: "call-a",
          toolName: "web_search"
        }
      ]),
      {
        content: '{"results":[]}',
        role: "tool",
        toolCallId: "call-a",
        toolName: "web_search"
      }
    ];

    const result = sanitizeToolCallPairing(messages);
    expect(result.insertedCount).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it("drops unexecuted tool_calls from assistant turns with partial results", () => {
    const messages: ConversationMessage[] = [
      assistantToolCallsMessage([
        {
          input: { content: "first", path: "a.txt" },
          reason: "write",
          toolCallId: "call-a",
          toolName: "write_file"
        },
        {
          input: { content: "second", path: "b.txt" },
          reason: "write",
          toolCallId: "call-b",
          toolName: "write_file"
        }
      ]),
      {
        content: JSON.stringify({
          error: "Approval denied",
          errorCode: "approval_denied",
          recoverable: true
        }),
        role: "tool",
        toolCallId: "call-a",
        toolName: "write_file"
      }
    ];

    const result = sanitizeToolCallPairing(messages);
    expect(result.insertedCount).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.toolCalls?.map((toolCall) => toolCall.toolCallId)).toEqual(["call-a"]);
  });

  it("removes orphan tool results when assistant tool_calls were cleared", () => {
    const messages: ConversationMessage[] = [
      {
        content: "calling tool",
        role: "assistant",
        toolCalls: []
      },
      {
        content: "orphan",
        role: "tool",
        toolCallId: "call-a",
        toolName: "read_file"
      }
    ];

    const result = sanitizeToolCallPairing(messages);
    expect(result.insertedCount).toBe(1);
    expect(messages).toEqual([{ content: "calling tool", role: "assistant" }]);
  });
});

describe("findLastAssistantToolCallsResponse", () => {
  it("returns the most recent assistant message that contains tool calls", () => {
    const messages: ConversationMessage[] = [
      assistantToolCallsMessage([
        {
          input: { query: "old" },
          reason: "search",
          toolCallId: "call-old",
          toolName: "web_search"
        }
      ]),
      assistantMessage("final answer")
    ];

    const response = findLastAssistantToolCallsResponse(messages);
    expect(response?.kind).toBe("tool_calls");
    expect(response?.toolCalls[0]?.toolCallId).toBe("call-old");
    expect(response?.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
