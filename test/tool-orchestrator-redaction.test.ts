import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ContextPolicy } from "../src/policy/context-policy.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { DEFAULT_LOCAL_POLICY_CONFIG } from "../src/policy/default-policy-config.js";
import { ToolOrchestrator } from "../src/tools/tool-orchestrator.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import type {
  ToolCallRecord,
  ToolCallRepository,
  ToolDefinition,
  ToolExecutionContext
} from "../src/types/index.js";

describe("tool orchestrator restricted output", () => {
  it("returns redacted output for restricted tools", async () => {
    const records = new Map<string, ToolCallRecord>();
    const orchestrator = new ToolOrchestrator({
      approvalRuleStore: { hasFingerprint: () => true } as never,
      approvalService: { ensureApprovalRequest: () => { throw new Error("skip"); } } as never,
      artifactRepository: { createMany: () => undefined } as never,
      auditService: { record: () => undefined } as never,
      clarifyService: {} as never,
      contextPolicy: new ContextPolicy(),
      policyEngine: new PolicyEngine(DEFAULT_LOCAL_POLICY_CONFIG),
      toolCallRepository: createToolCallRepository(records),
      toolRegistry: new ToolRegistry().register(createRestrictedShellTool()),
      traceService: { record: () => undefined } as never
    });

    const outcome = await orchestrator.execute(
      {
        input: { command: "echo secret-token" },
        iteration: 1,
        reason: "Check output",
        taskId: "task-redact",
        toolCallId: "call-redact",
        toolName: "shell"
      },
      createContext()
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") {
      return;
    }
    expect(outcome.result.success).toBe(true);
    expect(String(outcome.result.output)).toContain("[REDACTED: restricted content]");
  });
});

function createRestrictedShellTool(): ToolDefinition {
  const schema = z.object({ command: z.string() });
  return {
    capability: "shell.execute",
    execute: () =>
      Promise.resolve({
        artifacts: [],
        output: "secret-token=abc123",
        success: true,
        summary: "shell finished"
      }),
    inputSchema: schema,
    name: "shell",
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
          pathScope: "workspace"
        }
      };
    },
    privacyLevel: "restricted",
    riskLevel: "high",
    sideEffectLevel: "external_mutation",
    toolKind: "external_tool"
  };
}

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-redact",
    userId: "user-1",
    workspaceRoot: process.cwd()
  };
}

function createToolCallRepository(records: Map<string, ToolCallRecord>): ToolCallRepository {
  return {
    create(input) {
      const record = { ...input } as ToolCallRecord;
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
        throw new Error("missing");
      }
      const next = { ...current, ...patch };
      records.set(toolCallId, next);
      return next;
    }
  };
}
