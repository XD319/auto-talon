import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import { ToolOrchestrator } from "../src/tools/tool-orchestrator.js";
import type {
  ApprovalRecord,
  Provider,
  ProviderInput,
  ProviderResponse,
  ToolCallRecord
} from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "governance-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("execution kernel governance in parallel batches", () => {
  it("does not execute later parallel tools when an earlier tool requires approval", async () => {
    const workspaceRoot = await createTempWorkspace();
    const fullExecutions: string[] = [];
    let generation = 0;

    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      provider: new ScriptedProvider(() => {
        generation += 1;
        if (generation === 1) {
          return {
            kind: "tool_calls",
            message: "Read two files.",
            toolCalls: [
              {
                input: { path: "a.txt" },
                reason: "Read a",
                toolCallId: "read-a",
                toolName: "read_file"
              },
              {
                input: { path: "b.txt" },
                reason: "Read b",
                toolCallId: "read-b",
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 8, outputTokens: 4 }
          };
        }
        return {
          kind: "final",
          message: "done",
          usage: { inputTokens: 1, outputTokens: 1 }
        };
      })
    });

    const originalExecute = Reflect.get(ToolOrchestrator.prototype, "execute");
    const executeSpy = vi.spyOn(ToolOrchestrator.prototype, "execute").mockImplementation(async function (
      this: ToolOrchestrator,
      request,
      context
    ) {
      if (context.governanceOnly === true && request.toolCallId === "read-a") {
        const toolCall = buildPendingToolCall(request.toolCallId, request.toolName, request.taskId);
        const approval = buildPendingApproval(request.taskId, request.toolCallId, request.toolName);
        return {
          approval,
          kind: "approval_required",
          toolCall
        };
      }
      if (context.governanceOnly !== true && request.toolName === "read_file") {
        fullExecutions.push(request.toolCallId);
      }
      return Reflect.apply(originalExecute, this, [request, context]);
    });

    try {
      const options = createDefaultRunOptions("parallel governance", workspaceRoot, handle.config);
      const result = await handle.service.runTask(options);
      expect(result.task.status).toBe("waiting_approval");
      expect(fullExecutions).not.toContain("read-b");
      expect(fullExecutions).not.toContain("read-a");
    } finally {
      executeSpy.mockRestore();
      handle.close();
    }
  });
});

describe("execution kernel provider error mapping", () => {
  it.each([2, 1])("handles two reasoning-only summaries with maxIterations=%i", async (maxIterations) => {
    const workspaceRoot = await createTempWorkspace();
    let calls = 0;
    let resumedWithTools = false;
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db"), workflow: { completionVerification: { enabled: false } } as never },
      provider: new ScriptedProvider((input) => {
        calls += 1;
        if (calls === 4) resumedWithTools = input.availableTools.length > 0;
        return { kind: "final", message: calls === 4 ? "Completed the task." : "Let me think. I need to inspect this. Wait, let me re-read.",
          usage: { inputTokens: 1, outputTokens: 1 } };
      })
    });
    try {
      const options = createDefaultRunOptions("finish task", workspaceRoot, handle.config);
      options.maxIterations = maxIterations;
      const result = await handle.service.runTask(options);
      const events = handle.service.showTask(result.task.taskId).trace.map((event) => event.eventType);
      if (maxIterations === 2) {
        expect(result.task.status).toBe("succeeded");
        expect(result.output).toBe("Completed the task.");
        expect(resumedWithTools).toBe(true);
        expect(events).toContain("reasoning_only_final_resumed");
      } else {
        expect(result.task.status).not.toBe("succeeded");
        expect(resumedWithTools).toBe(false);
        expect(events).toContain("final_summary_exhausted");
      }
      expect(result.task.currentIteration).toBeLessThanOrEqual(maxIterations);
    } finally { handle.close(); }
  });

  it("accepts a normal final without summary retries", async () => {
    const workspaceRoot = await createTempWorkspace();
    let calls = 0;
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db"), workflow: { completionVerification: { enabled: false } } as never },
      provider: new ScriptedProvider(() => {
        calls += 1;
        return { kind: "final", message: "The requested work is complete.", usage: { inputTokens: 1, outputTokens: 1 } };
      })
    });
    try {
      const result = await handle.service.runTask(createDefaultRunOptions("finish task", workspaceRoot, handle.config));
      expect(result.task.status).toBe("succeeded");
      expect(calls).toBe(1);
    } finally { handle.close(); }
  });

  it("preserves provider errors during final summary instead of mapping to max_rounds_exceeded", async () => {
    const workspaceRoot = await createTempWorkspace();
    let generation = 0;

    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      provider: new ScriptedProvider(() => {
        generation += 1;
        if (generation === 1) {
          return {
            kind: "final",
            message: "quick answer",
            usage: { inputTokens: 1, outputTokens: 1 }
          };
        }
        throw new Error("provider auth failed");
      })
    });

    try {
      const options = createDefaultRunOptions("provider error mapping", workspaceRoot, handle.config);
      options.maxIterations = 0;
      const result = await handle.service.runTask(options);
      expect(result.error?.code).not.toBe("max_rounds_exceeded");
    } finally {
      handle.close();
    }
  });
});

function buildPendingToolCall(toolCallId: string, toolName: string, taskId: string): ToolCallRecord {
  return {
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    input: {},
    iteration: 1,
    output: null,
    requestedAt: new Date().toISOString(),
    riskLevel: "low",
    startedAt: null,
    status: "awaiting_approval",
    summary: null,
    taskId,
    toolCallId,
    toolName
  };
}

function buildPendingApproval(taskId: string, toolCallId: string, toolName: string): ApprovalRecord {
  return {
    allowScope: null,
    approvalId: "approval-test",
    decidedAt: null,
    errorCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    fingerprint: "fp-test",
    policyDecisionId: "policy-test",
    reason: "test approval",
    requestedAt: new Date().toISOString(),
    requesterUserId: "user-test",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId,
    toolCallId,
    toolName
  };
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = join(
    tmpdir(),
    `auto-talon-governance-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  tempPaths.push(workspaceRoot);
  await fs.mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}
