import { describe, expect, it } from "vitest";

import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import type { ProviderToolDescriptor, TaskRecord } from "../src/types/index.js";

describe("context compactor", () => {
  it("extracts goal, decisions, open loops, actions and capabilities", () => {
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

    const sessionMemory = compactor.buildSessionMemory({
      availableTools,
      compact: {
        maxMessagesBeforeCompact: 6,
        messages: [
          {
            content: "My long-running objective and email me at demo@example.com with token=ghp_abcdefghijklmnopqrstuvwxyz",
            role: "user"
          },
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
          { content: "Next Actions:\n- execute pending Shell command", role: "assistant" }
        ],
        reason: "message_count",
        sessionScopeKey: "task-1",
        taskId: "task-1"
      },
      task
    });

    expect(sessionMemory.goal).toContain("My long-running objective");
    expect(sessionMemory.decisions.join(" ")).toContain("Next Actions");
    expect(sessionMemory.openLoops.join(" ")).toContain("tc-1");
    expect(sessionMemory.nextActions.length).toBeGreaterThan(0);
    expect(sessionMemory.decisions.every((item) => item.length <= 123)).toBe(true);
    expect(sessionMemory.nextActions.every((item) => item.length <= 123)).toBe(true);
    expect(sessionMemory.nextActions.length).toBeLessThanOrEqual(3);
    expect(sessionMemory.summary).toContain("completedWork=");
    expect(sessionMemory.summary).toContain("filesTouched=");
    expect(sessionMemory.summary).toContain("commandsRun=");
    expect(sessionMemory.summary).toContain("blockers=");
    expect(sessionMemory.summary).toContain("[REDACTED_EMAIL]");
    expect(sessionMemory.summary).toContain("token=[REDACTED]");
    expect(
      Array.isArray(sessionMemory.metadata?.toolCapabilitySummary) &&
        sessionMemory.metadata.toolCapabilitySummary.includes("Shell")
    ).toBe(true);
  });

  it("does not infer next actions from ordinary final summaries", () => {
    const compactor = new ContextCompactor();
    const task = createTask("task-summary");

    const sessionMemory = compactor.buildSessionMemory({
      availableTools: [],
      compact: {
        maxMessagesBeforeCompact: 4,
        messages: [
          { content: "implement feature", role: "user" },
          {
            content:
              "No files were changed in this run. I reviewed the plan and summarized the existing implementation.",
            role: "assistant"
          }
        ],
        reason: "context_budget",
        sessionScopeKey: "task-summary",
        taskId: "task-summary"
      },
      task
    });

    expect(sessionMemory.nextActions).toEqual([]);
  });

  it("falls back to originalGoal when no user messages remain after multiple compactions", () => {
    const compactor = new ContextCompactor();
    const task = {
      ...createTask("task-multi-compact"),
      input: "Complete phase 2 of the snake game development plan"
    };

    const sessionMemory = compactor.buildSessionMemory({
      availableTools: [],
      compact: {
        maxMessagesBeforeCompact: 3,
        // Simulates the post-compaction state where only system-summary, assistant,
        // and tool messages survive; user message has scrolled out of the tail.
        messages: [
          { content: "Session summary:\ngoal=...\nlatest_user_request=...", role: "system" },
          {
            content: "I'll read the file next.",
            role: "assistant",
            toolCalls: [{ toolCallId: "tc-99", toolName: "file_read" }]
          },
          { content: "{\"content\":\"...\"}", role: "tool", toolCallId: "tc-99", toolName: "file_read" }
        ],
        originalGoal: "Complete phase 2 of the snake game development plan",
        reason: "context_budget",
        sessionScopeKey: "task-multi-compact",
        taskId: "task-multi-compact"
      },
      task
    });

    expect(sessionMemory.summary).toContain("goal=Complete phase 2 of the snake game development plan");
    expect(sessionMemory.summary).toContain(
      "latest_user_request=Complete phase 2 of the snake game development plan"
    );
    expect(sessionMemory.summary).not.toContain("goal=[n/a]");
    expect(sessionMemory.summary).not.toContain("latest_user_request=[n/a]");
  });

  it("prefers in-window user message over originalGoal when both are present", () => {
    const compactor = new ContextCompactor();
    const task = {
      ...createTask("task-prefer-user"),
      input: "outdated original goal"
    };

    const sessionMemory = compactor.buildSessionMemory({
      availableTools: [],
      compact: {
        maxMessagesBeforeCompact: 4,
        messages: [
          { content: "newer user instruction", role: "user" },
          { content: "acknowledged", role: "assistant" }
        ],
        originalGoal: "outdated original goal",
        reason: "message_count",
        sessionScopeKey: "task-prefer-user",
        taskId: "task-prefer-user"
      },
      task
    });

    expect(sessionMemory.summary).toContain("goal=newer user instruction");
    expect(sessionMemory.summary).toContain("latest_user_request=newer user instruction");
  });
});

function createTask(taskId: string): TaskRecord {
  return {
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
    taskId,
    threadId: "thread-1",
    tokenBudget: { inputLimit: 1000, outputLimit: 500, reservedOutput: 100, usedInput: 0, usedOutput: 0 },
    updatedAt: "2026-01-01T00:00:01.000Z"
  };
}
