import { describe, expect, it } from "vitest";

import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import { buildHygieneConversationMessages } from "../src/runtime/sessions/build-hygiene-conversation-messages.js";
import { StorageManager } from "../src/storage/database.js";
import type { TaskRecord } from "../src/types/index.js";

describe("buildHygieneConversationMessages", () => {
  it("prefers transcript tool events over lossy session message records", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        metadata: {},
        ownerUserId: "test-user",
        providerName: "mock",
        sessionId: "session-hygiene",
        title: "Transcript hygiene session"
      });
      storage.sessionMessages.append({
        kind: "user",
        messageId: "ui-user",
        payload: { text: "short ui text" },
        sessionId: "session-hygiene"
      });
      storage.sessionTranscripts.append({
        content: "inspect src/main.ts",
        eventType: "user_message",
        role: "user",
        sessionId: "session-hygiene"
      });
      storage.sessionTranscripts.append({
        content: "read file",
        eventType: "tool_call",
        payload: {
          toolCalls: [
            {
              input: { path: "src/main.ts" },
              reason: "inspect implementation",
              toolCallId: "tc-hygiene-read",
              toolName: "read_file"
            }
          ]
        },
        role: "assistant",
        sessionId: "session-hygiene"
      });
      storage.sessionTranscripts.append({
        content: '{"content":"export function main() {}"}',
        eventType: "tool_result",
        payload: {
          toolCallId: "tc-hygiene-read",
          toolName: "read_file"
        },
        role: "tool",
        sessionId: "session-hygiene"
      });

      const messages = buildHygieneConversationMessages({
        sessionId: "session-hygiene",
        sessionMessageRepository: storage.sessionMessages,
        sessionTranscriptRepository: storage.sessionTranscripts
      });
      const summary = new ContextCompactor().buildSessionSummary({
        availableTools: [],
        compact: {
          maxMessagesBeforeCompact: messages.length,
          messages,
          reason: "context_budget",
          sessionScopeKey: "session-hygiene",
          taskId: "task-hygiene"
        },
        task: createTask("session-hygiene")
      });

      expect(messages.some((message) => message.role === "tool" && message.toolName === "read_file")).toBe(
        true
      );
      expect(summary.summary).toContain("src/main.ts");
      expect(summary.summary).toContain("## Relevant Files");
    } finally {
      storage.close();
    }
  });
});

function createTask(sessionId: string): TaskRecord {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 0,
    cwd: process.cwd(),
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "continue",
    maxIterations: 1,
    metadata: {},
    providerName: "mock",
    requesterUserId: "test-user",
    sessionId,
    startedAt: now,
    status: "running",
    taskId: "task-hygiene",
    tokenBudget: {
      inputLimit: 1_000,
      outputLimit: 400,
      reservedOutput: 50,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: now
  };
}
