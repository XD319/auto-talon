import { describe, expect, it, vi } from "vitest";

import {
  CheckpointManager,
  CompletionController,
  hasCompletionIntent,
  mentionsUnverifiedWork
} from "../src/runtime/kernel/index.js";
import type { ToolOrchestrator } from "../src/tools/index.js";
import type {
  ConversationMessage,
  ExecutionCheckpointRecord,
  ExecutionCheckpointRepository,
  ProviderToolDescriptor,
  TaskRecord
} from "../src/types/index.js";

const descriptor = (
  name: string,
  capability: ProviderToolDescriptor["capability"]
): ProviderToolDescriptor => ({
  capability,
  description: name,
  inputSchema: { type: "object" },
  name,
  privacyLevel: "internal",
  riskLevel: "low"
});

const toolMessage = (toolName: string, content: string): ConversationMessage => ({
  content,
  metadata: {
    privacyLevel: "internal",
    retentionKind: "session",
    sourceType: "tool_result"
  },
  role: "tool",
  toolCallId: `${toolName}-call`,
  toolName
});

const assistantToolCallMessage = (): ConversationMessage => ({
  content: "",
  role: "assistant",
  toolCalls: [
    {
      input: { path: "a.txt" },
      reason: "Read file",
      toolCallId: "read-call",
      toolName: "file_read"
    }
  ]
});

const task = (): TaskRecord => ({
  agentProfileId: "executor",
  createdAt: "2026-06-05T00:00:00.000Z",
  currentIteration: 1,
  cwd: "D:/repo",
  errorCode: null,
  errorMessage: null,
  finalOutput: null,
  finishedAt: null,
  input: "task",
  maxIterations: 3,
  metadata: {},
  providerName: "test",
  requesterUserId: "user",
  startedAt: "2026-06-05T00:00:00.000Z",
  status: "waiting_approval",
  taskId: "task-1",
  threadId: "thread-1",
  tokenBudget: {
    inputLimit: 1000,
    outputLimit: 1000,
    reservedOutput: 100,
    usedInput: 0,
    usedOutput: 0
  },
  updatedAt: "2026-06-05T00:00:00.000Z"
});

describe("CompletionController", () => {
  it("classifies read-only tool calls from descriptors before name heuristics", () => {
    const controller = new CompletionController({
      describeTool: (toolName) =>
        toolName === "inspect_workspace"
          ? descriptor("inspect_workspace", "filesystem.read")
          : descriptor(toolName, "filesystem.write"),
      recordTrace: vi.fn()
    });

    expect(controller.isReadOnlyToolCall("inspect_workspace")).toBe(true);
    expect(controller.isReadOnlyToolCall("file_read_but_mutates")).toBe(false);
  });

  it("recognizes completion and unverified wording", () => {
    expect(hasCompletionIntent("Implementation is complete and functional.")).toBe(true);
    expect(hasCompletionIntent("Let me inspect one more file.")).toBe(false);
    expect(mentionsUnverifiedWork("Could not verify because tests are unavailable.")).toBe(true);
  });
});

describe("CheckpointManager", () => {
  it("restores successful write evidence and tool-call signatures from checkpoint history", () => {
    const checkpoint: ExecutionCheckpointRecord = {
      iteration: 2,
      memoryContext: [],
      messages: [
        assistantToolCallMessage(),
        toolMessage("file_read", JSON.stringify({ path: "a.txt" })),
        toolMessage("file_write", JSON.stringify({ bytesWritten: 12, path: "b.txt" }))
      ],
      pendingClarifyPromptId: null,
      pendingToolCalls: [],
      taskId: "task-1",
      updatedAt: "2026-06-05T00:00:00.000Z"
    };
    const repository: ExecutionCheckpointRepository = {
      delete: vi.fn(),
      findByTaskId: () => checkpoint,
      save: (record) => record
    };
    const toolOrchestrator = {
      describeTool: (toolName: string) =>
        toolName === "file_write"
          ? descriptor(toolName, "filesystem.write")
          : descriptor(toolName, "filesystem.read")
    } as unknown as ToolOrchestrator;
    const manager = new CheckpointManager({
      executionCheckpointRepository: repository,
      toolOrchestrator
    });

    const restored = manager.loadForResume(task());

    expect(restored.writeToolSucceeded).toBe(true);
    expect(restored.toolCallSignatures.size).toBe(1);
    expect(restored.toolCallSignatures.get('file_read|{"path":"a.txt"}')).toEqual({
      iteration: 1,
      toolCallId: "read-call"
    });
  });
});
