import { describe, expect, it } from "vitest";

import { historyHasSuccessfulWrite } from "../src/runtime/kernel-support.js";
import type { ConversationMessage } from "../src/types/index.js";

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
