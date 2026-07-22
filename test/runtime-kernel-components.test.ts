import { describe, expect, it, vi } from "vitest";

import {
  buildReadOnlyAnalysisGuardMessage,
  CheckpointManager,
  CompletionController,
  hasCompletionIntent,
  isSuccessfulVerificationToolCall,
  isVerificationCommand,
  mentionsUnverifiedWork,
  READ_ONLY_GUARD_THRESHOLD
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
      toolName: "read_file"
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
  sessionId: "session-1",
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

  it("builds mode-aware read-only analysis guard messages", () => {
    const agentMessage = buildReadOnlyAnalysisGuardMessage("agent");
    const planMessage = buildReadOnlyAnalysisGuardMessage("plan");

    expect(agentMessage).toContain("synthesis guard");
    expect(agentMessage).not.toContain("todo");
    expect(planMessage).toContain("Do not call write, patch, shell, or todo tools");
    expect(planMessage).not.toMatch(/\btodo tool\b/u);
  });

  it("includes configured test commands in completion verification guard", () => {
    const controller = new CompletionController({
      describeTool: () => descriptor("patch", "filesystem.write"),
      recordTrace: vi.fn(),
      testCommands: ["node check.js", "npm test"]
    });
    const messages: ConversationMessage[] = [];
    const state = {
      completionIntentSeenAt: null,
      completionVerificationGuardEmitted: false,
      completionVerificationSatisfied: false,
      completionVerificationSatisfiedEmitted: false,
      criticalBudgetPressureEmitted: false,
      maxIterations: 4,
      messages,
      postCompletionVerificationReads: 0,
      readOnlyTurns: 0,
      silentToolTurns: 0,
      turnProviderMessages: messages,
      warningBudgetPressureEmitted: false,
      writeToolSucceeded: true
    };

    const decision = controller.evaluateFinalVerification(
      state,
      messages,
      task(),
      2,
      "Implementation complete."
    );
    expect(decision.kind).toBe("guard");
    expect(messages.at(-1)?.content).toContain("Suggested commands: node check.js, npm test");
  });

  it("recognizes node verification scripts and configured test commands", () => {
    expect(isVerificationCommand("node --test")).toBe(true);
    expect(isVerificationCommand("node verify.mjs")).toBe(true);
    expect(isVerificationCommand("node check.js", ["node check.js"])).toBe(true);
    expect(isVerificationCommand("npm test")).toBe(true);
    expect(isVerificationCommand("node -e \"console.log(1)\"")).toBe(false);
    expect(isVerificationCommand("echo hello")).toBe(false);
  });

  it("treats successful node verify shell calls as verification evidence", () => {
    expect(
      isSuccessfulVerificationToolCall("shell", {
        output: { command: "node verify.mjs", exitCode: 0, stdout: "ok" },
        success: true,
        summary: "verified"
      })
    ).toBe(true);
    expect(
      isSuccessfulVerificationToolCall("process", {
        output: { command: "npm test", exitCode: 0 },
        success: true,
        summary: "verified"
      })
    ).toBe(true);
    expect(
      isSuccessfulVerificationToolCall("read_file", {
        output: { path: "a.txt" },
        success: true,
        summary: "read"
      })
    ).toBe(false);
  });

  it("appends unverified warning without looping when guard is disabled", () => {
    const recordTrace = vi.fn();
    const controller = new CompletionController({
      describeTool: () => descriptor("write_file", "filesystem.write"),
      recordTrace
    });
    const messages: ConversationMessage[] = [];
    const state = {
      completionIntentSeenAt: null,
      completionVerificationGuardEmitted: false,
      completionVerificationSatisfied: false,
      completionVerificationSatisfiedEmitted: false,
      criticalBudgetPressureEmitted: false,
      maxIterations: 4,
      messages,
      postCompletionVerificationReads: 0,
      readOnlyTurns: 0,
      silentToolTurns: 0,
      turnProviderMessages: messages,
      warningBudgetPressureEmitted: false,
      writeToolSucceeded: true
    };

    const decision = controller.evaluateFinalVerification(
      state,
      messages,
      task(),
      3,
      "Done.",
      { allowGuard: false }
    );
    expect(decision).toEqual({
      finalOutput:
        "Done.\n\nUnverified: workspace changes were made after the last successful verification, and no verification command was recorded.",
      kind: "complete"
    });
    expect(messages).toHaveLength(0);
    expect(recordTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "completion_verification_missing",
        payload: expect.objectContaining({ reason: "runtime_appended_warning" }) as object
      })
    );
  });

  it("injects read-only analysis guard after many consecutive read-only tool turns", () => {
    const recordTrace = vi.fn();
    const controller = new CompletionController({
      describeTool: () => descriptor("read_file", "filesystem.read"),
      recordTrace
    });
    const messages: ConversationMessage[] = [];
    const state = {
      completionIntentSeenAt: null,
      completionVerificationGuardEmitted: false,
      completionVerificationSatisfied: false,
      completionVerificationSatisfiedEmitted: false,
      criticalBudgetPressureEmitted: false,
      maxIterations: 20,
      messages,
      postCompletionVerificationReads: 0,
      readOnlyTurns: 0,
      silentToolTurns: 0,
      turnProviderMessages: messages,
      warningBudgetPressureEmitted: false,
      writeToolSucceeded: false
    };
    const toolTurn = {
      kind: "tool_calls" as const,
      message: "让我继续读取剩余部分",
      toolCalls: [{ arguments: { path: "game.js" }, toolCallId: "tc-1", toolName: "read_file" }]
    };

    for (let iteration = 1; iteration < READ_ONLY_GUARD_THRESHOLD; iteration += 1) {
      controller.observeProviderToolTurn(state, messages, task(), iteration, toolTurn);
    }
    expect(messages.some((message) => message.content.includes("synthesis guard"))).toBe(false);

    controller.observeProviderToolTurn(
      state,
      messages,
      task(),
      READ_ONLY_GUARD_THRESHOLD,
      toolTurn,
      "plan"
    );
    expect(messages.some((message) => message.content.includes("Do not call write, patch, shell, or todo tools"))).toBe(
      true
    );
    expect(recordTrace).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "read_only_analysis_guard" })
    );
  });
});

describe("CheckpointManager", () => {
  it("restores successful write evidence and tool-call signatures from checkpoint history", () => {
    const checkpoint: ExecutionCheckpointRecord = {
      iteration: 2,
      memoryContext: [],
      messages: [
        assistantToolCallMessage(),
        toolMessage("read_file", JSON.stringify({ path: "a.txt" })),
        toolMessage("write_file", JSON.stringify({ bytesWritten: 12, path: "b.txt" }))
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
        toolName === "write_file" || toolName === "patch"
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
    expect(restored.toolCallSignatures.get('read_file|{"path":"a.txt"}')).toEqual({
      iteration: 1,
      toolCallId: "read-call"
    });
  });
});
