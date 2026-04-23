import { describe, expect, it } from "vitest";

import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import type { ContextFragment, ProviderToolDescriptor, TaskRecord } from "../src/types/index.js";

describe("context compactor", () => {
  it("extracts goal, open loops, blocked reason, actions and capabilities", () => {
    const compactor = new ContextCompactor();
    const task: TaskRecord = {
      agentProfileId: "executor",
      createdAt: "2026-01-01T00:00:00.000Z",
      currentIteration: 1,
      cwd: "/tmp/workspace",
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: "Primary objective",
      maxIterations: 8,
      metadata: {},
      providerName: "mock",
      requesterUserId: "u1",
      startedAt: "2026-01-01T00:00:01.000Z",
      status: "running",
      taskId: "task-1",
      threadId: "thread-1",
      tokenBudget: { inputLimit: 1000, outputLimit: 500, reservedOutput: 100, usedInput: 0, usedOutput: 0 },
      updatedAt: "2026-01-01T00:00:01.000Z"
    };
    const memoryContext: ContextFragment[] = [
      {
        confidence: 0.9,
        explanation: "cached",
        fragmentId: "f1",
        memoryId: "mem-1",
        privacyLevel: "internal",
        retentionPolicy: { kind: "session", reason: "session", ttlDays: null },
        scope: "session",
        sourceType: "user_input",
        status: "verified",
        text: "memory text",
        title: "memory title"
      }
    ];
    const availableTools: ProviderToolDescriptor[] = [
      {
        capability: "shell.execute",
        description: "shell",
        inputSchema: { type: "object", properties: {}, required: [] },
        name: "Shell",
        privacyLevel: "internal",
        riskLevel: "medium"
      }
    ];

    const snapshot = compactor.buildSnapshot({
      availableTools,
      compact: {
        maxMessagesBeforeCompact: 6,
        messages: [
          { content: "My long-running objective", role: "user" },
          {
            content: "I will run tools",
            role: "assistant",
            toolCalls: [{ toolCallId: "tc-1", toolName: "Shell" }]
          },
          {
            content: "approval denied by policy",
            role: "tool",
            toolCallId: "tc-2",
            toolName: "Shell"
          },
          { content: "Next I should execute pending Shell command", role: "assistant" }
        ],
        reason: "message_count",
        sessionScopeKey: "task-1",
        taskId: "task-1"
      },
      memoryContext,
      task
    });

    expect(snapshot.goal).toContain("My long-running objective");
    expect(snapshot.openLoops.join(" ")).toContain("tc-1");
    expect(snapshot.blockedReason?.toLowerCase()).toContain("approval denied");
    expect(snapshot.nextActions.length).toBeGreaterThan(0);
    expect(snapshot.activeMemoryIds).toContain("mem-1");
    expect(snapshot.toolCapabilitySummary).toContain("Shell");
  });
});
