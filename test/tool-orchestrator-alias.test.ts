import { describe, expect, it } from "vitest";
import { z } from "zod";

import { PolicyEngine } from "../src/policy/policy-engine.js";
import { DEFAULT_LOCAL_POLICY_CONFIG } from "../src/policy/default-policy-config.js";
import { ToolOrchestrator } from "../src/tools/tool-orchestrator.js";
import type {
  ToolCallRecord,
  ToolCallRepository,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult
} from "../src/types/index.js";

describe("ToolOrchestrator aliases", () => {
  it("resolves bash-style tool names to the governed shell tool", async () => {
    const records = new Map<string, ToolCallRecord>();
    const shellTool = createShellLikeTool();
    const orchestrator = createOrchestrator(shellTool, records);

    expect(orchestrator.describeTool("bash")).toMatchObject({
      capability: "shell.execute",
      name: "shell"
    });
    expect(orchestrator.describeTool("Bash")).toMatchObject({
      capability: "shell.execute",
      name: "shell"
    });

    const outcome = await orchestrator.execute(
      {
        input: { command: "node -v" },
        iteration: 1,
        reason: "Check runtime",
        taskId: "task-alias",
        toolCallId: "call-alias",
        toolName: "Bash"
      },
      createContext()
    );

    expect(outcome.kind).toBe("completed");
    expect(records.get("call-alias")?.status).toBe("finished");
  });

  it("resolves common test runner aliases to test_run", async () => {
    const records = new Map<string, ToolCallRecord>();
    const testRunTool = createShellLikeTool("test_run");
    const orchestrator = createOrchestrator(testRunTool, records);

    expect(orchestrator.describeTool("run_tests")).toMatchObject({
      capability: "shell.execute",
      name: "test_run"
    });
    expect(orchestrator.describeTool("test")).toMatchObject({
      capability: "shell.execute",
      name: "test_run"
    });

    const outcome = await orchestrator.execute(
      {
        input: { command: "npm test" },
        iteration: 1,
        reason: "Verify task",
        taskId: "task-test-alias",
        toolCallId: "call-test-alias",
        toolName: "run_tests"
      },
      createContext()
    );

    expect(outcome.kind).toBe("completed");
    expect(records.get("call-test-alias")?.status).toBe("finished");
  });

  it("feeds shell execution failures back as recoverable tool results", async () => {
    const records = new Map<string, ToolCallRecord>();
    const failingShellTool = createShellLikeTool("shell", {
      errorCode: "tool_execution_error",
      errorMessage: "Command exited with code 1.",
      success: false
    });
    const orchestrator = createOrchestrator(failingShellTool, records);

    const outcome = await orchestrator.execute(
      {
        input: { command: "npm test" },
        iteration: 1,
        reason: "Run verification",
        taskId: "task-shell-failure",
        toolCallId: "call-shell-failure",
        toolName: "bash"
      },
      createContext()
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      throw new Error("Expected completed recoverable shell failure.");
    }
    expect(outcome.result.success).toBe(false);
    expect(records.get("call-shell-failure")).toMatchObject({
      errorCode: "tool_execution_error",
      status: "failed"
    });
  });
});

function createShellLikeTool(
  name = "shell",
  result: ToolExecutionResult = {
    output: {
      stdout: "ok"
    },
    success: true,
    summary: "executed"
  }
): ToolDefinition<z.ZodObject<{ command: z.ZodString }>, { command: string }> {
  const schema = z.object({
    command: z.string()
  });
  return {
    approvalDefault: "when_needed",
    capability: "shell.execute",
    costLevel: "moderate",
    description: "Execute shell command",
    execute: () => Promise.resolve(result),
    inputSchema: schema,
    name,
    prepare: (input) => {
      const parsed = schema.parse(input);
      return {
        governance: {
          pathScope: "workspace",
          summary: parsed.command
        },
        preparedInput: parsed,
        sandbox: {
          command: parsed.command,
          cwd: process.cwd(),
          envKeys: [],
          executable: "node",
          kind: "shell",
          networkAccess: "disabled",
          pathScope: "workspace",
          timeoutMs: 1_000
        }
      };
    },
    privacyLevel: "restricted",
    riskLevel: "high",
    sideEffectLevel: "external_mutation",
    toolKind: "external_tool"
  };
}

function createOrchestrator(
  tool: ToolDefinition,
  records: Map<string, ToolCallRecord>
): ToolOrchestrator {
  return new ToolOrchestrator({
    approvalRuleStore: {
      hasFingerprint: () => true
    } as never,
    approvalService: {
      ensureApprovalRequest: () => {
        throw new Error("approval should be skipped by fingerprint store");
      }
    } as never,
    artifactRepository: {
      createMany: () => undefined
    } as never,
    auditService: {
      record: () => undefined
    } as never,
    clarifyService: {} as never,
    contextPolicy: {
      redactText: (value: string) => value
    } as never,
    policyEngine: new PolicyEngine(DEFAULT_LOCAL_POLICY_CONFIG),
    toolCallRepository: createToolCallRepository(records),
    tools: [tool],
    traceService: {
      record: () => undefined
    } as never
  });
}

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-alias",
    userId: "user-1",
    workspaceRoot: process.cwd()
  };
}

function createToolCallRepository(
  records: Map<string, ToolCallRecord>
): ToolCallRepository {
  return {
    create(input) {
      const record = {
        ...input
      } as ToolCallRecord;
      records.set(record.toolCallId, record);
      return record;
    },
    findById(toolCallId) {
      return records.get(toolCallId) ?? null;
    },
    listByTaskId(taskId) {
      return [...records.values()].filter((record) => record.taskId === taskId);
    },
    update(toolCallId, patch) {
      const current = records.get(toolCallId);
      if (current === undefined) {
        throw new Error(`Tool call ${toolCallId} not found`);
      }
      const next = {
        ...current,
        ...patch
      };
      records.set(toolCallId, next);
      return next;
    }
  };
}
