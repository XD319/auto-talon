import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepoMap, createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "workflow-scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const tempPaths: string[] = [];

const WORKFLOW_POLICY_CONFIG: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Allow configured test runner tool in workflow tests.",
      effect: "allow",
      id: "allow-test-run",
      match: {
        toolNames: ["test_run"]
      },
      priority: 100
    },
    {
      description: "Allow workspace file writes.",
      effect: "allow",
      id: "allow-workspace-file-write",
      match: {
        capabilities: ["filesystem.write"],
        pathScopes: ["workspace"]
      },
      priority: 90
    },
    {
      description: "Allow workspace reads.",
      effect: "allow",
      id: "allow-workspace-read",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace"]
      },
      priority: 80
    }
  ],
  source: "local"
};

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("coding workflow loop", () => {
  it("builds a repository map from workspace files", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const repoMap = buildRepoMap(workspaceRoot);

    expect(repoMap.languages).toContain("JavaScript");
    expect(repoMap.importantFiles).toContain("package.json");
    expect(repoMap.scripts.test).toBe("node check.js");
    expect(repoMap.summary).toContain("Repository map");
  });

  it("feeds repo map context and test_run failures back into a repair loop", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        defaultProfileId: "executor",
        workflow: {
          failureGuidedRetry: {
            enabled: true,
            maxRepairAttempts: 2
          },
          repoMap: {
            enabled: true
          },
          testCommands: ["node check.js"]
        }
      },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (!input.availableTools.some((tool) => tool.name === "test_run")) {
          throw new Error(`missing test_run tool: ${input.availableTools.map((tool) => tool.name).join(",")}`);
        }
        if (!input.messages.some((message) => message.content.includes("Repository map"))) {
          throw new Error(`missing repo map message: ${input.messages.map((message) => message.content).join(" | ")}`);
        }
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        const lastToolMessage = toolMessages.at(-1)?.content ?? "";

        if (toolMessages.length === 0) {
          return toolCallResponse("Run the configured test first.", [
            {
              input: {
                command: "node check.js"
              },
              reason: "Verify current code before repair.",
              toolCallId: "workflow-test-1",
              toolName: "test_run"
            }
          ]);
        }

        if (lastToolMessage.includes("\"passed\": false")) {
          return toolCallResponse("Repair the failing check.", [
            {
              input: {
                action: "update_file",
                newText: "process.exit(0);\n",
                path: "check.js",
                targetText: "process.exit(1);\n"
              },
              reason: "Make the check pass after the failed test feedback.",
              toolCallId: "workflow-repair",
              toolName: "file_write"
            }
          ]);
        }

        if (lastToolMessage.includes("\"passed\": true")) {
          return finalResponse("Repair loop complete; configured test passes.");
        }

        if (toolMessages.some((message) => message.content.includes("\"updated\": true"))) {
          return toolCallResponse("Re-run the configured test after repair.", [
            {
              input: {
                command: "node check.js"
              },
              reason: "Confirm the repair.",
              toolCallId: `workflow-test-${toolMessages.length + 1}`,
              toolName: "test_run"
            }
          ]);
        }

        return finalResponse("Repair loop complete; configured test passes.");
      })
    });

    try {
      const runOptions = createDefaultRunOptions("fix the failing workflow check", workspaceRoot, handle.config);
      runOptions.agentProfileId = "executor";
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);

      expect(details.trace.some((event) => event.eventType === "repo_map_created")).toBe(true);
      if (result.error?.message?.startsWith("missing test_run tool:")) {
        expect(result.task.status).toBe("failed");
        expect(result.error.message).toContain("test_run");
      } else {
        expect(result.error?.message).toBeUndefined();
        expect(result.task.status).toBe("succeeded");
        expect(await fs.readFile(join(workspaceRoot, "check.js"), "utf8")).toBe("process.exit(0);\n");
        expect(details.toolCalls.filter((toolCall) => toolCall.toolName === "test_run")).toHaveLength(2);
        expect(details.toolCalls.every((toolCall) => toolCall.status === "finished")).toBe(true);
      }
    } finally {
      handle.close();
    }
  }, 30000);

  it("requests a no-tools summary instead of failing when iterations are exhausted", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          return finalResponse("Summary after iteration budget: inspected the workspace.");
        }
        return toolCallResponse("Need one more look.", [
          {
            input: { action: "read_file", path: "package.json" },
            reason: "Keep inspecting.",
            toolCallId: `read-${input.iteration}`,
            toolName: "file_read"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("inspect until summary", workspaceRoot, handle.config);
      runOptions.maxIterations = 2;
      const result = await handle.service.runTask(runOptions);
      const trace = handle.service.traceTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Summary after iteration budget");
      expect(trace.some((event) => event.eventType === "iteration_budget_pressure")).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("stops post-completion read loops with a no-tools final summary", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          return finalResponse("第一阶段已完成：创建了页面和说明。");
        }
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return toolCallResponse("开始创建文件。", [
            {
              input: { action: "write_file", content: "done\n", path: "phase.txt" },
              reason: "Create the requested phase artifact.",
              toolCallId: "write-phase",
              toolName: "file_write"
            }
          ]);
        }
        return toolCallResponse("第一阶段已完成。", [
          {
            input: { action: "read_file", path: "phase.txt" },
            reason: "Verify the completed phase.",
            toolCallId: `verify-${input.iteration}`,
            toolName: "file_read"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("开发第一阶段", workspaceRoot, handle.config);
      runOptions.maxIterations = 8;
      const result = await handle.service.runTask(runOptions);
      const details = handle.service.showTask(result.task.taskId);
      const phaseReads = details.toolCalls.filter(
        (toolCall) => toolCall.toolName === "file_read" && toolCall.toolCallId.startsWith("verify-")
      );

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("第一阶段已完成");
      expect(phaseReads).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it("ignores tool calls returned by a no-tools final summary response", async () => {
    const workspaceRoot = await createWorkflowWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WORKFLOW_POLICY_CONFIG,
      provider: new ScriptedProvider((input) => {
        if (input.availableTools.length === 0) {
          return toolCallResponse("Summary with ignored tool call.", [
            {
              input: { action: "read_file", path: "package.json" },
              reason: "This should be ignored.",
              toolCallId: "ignored-read",
              toolName: "file_read"
            }
          ]);
        }
        return toolCallResponse("Keep reading.", [
          {
            input: { action: "read_file", path: "package.json" },
            reason: "Use the loop budget.",
            toolCallId: `budget-read-${input.iteration}`,
            toolName: "file_read"
          }
        ]);
      })
    });

    try {
      const runOptions = createDefaultRunOptions("summarize even with tools", workspaceRoot, handle.config);
      runOptions.maxIterations = 1;
      const result = await handle.service.runTask(runOptions);
      const trace = handle.service.traceTask(result.task.taskId);

      expect(result.task.status).toBe("succeeded");
      expect(result.output).toBe("Summary with ignored tool call.");
      expect(trace.some((event) => event.eventType === "no_tools_tool_calls_ignored")).toBe(true);
      expect(handle.service.showTask(result.task.taskId).toolCalls.some((call) => call.toolCallId === "ignored-read")).toBe(false);
    } finally {
      handle.close();
    }
  });
});

async function createWorkflowWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-workflow-loop-"));
  tempPaths.push(workspaceRoot);
  await fs.writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "workflow-fixture",
        scripts: {
          test: "node check.js"
        }
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(join(workspaceRoot, "check.js"), "process.exit(1);\n", "utf8");
  return workspaceRoot;
}

function toolCallResponse(message: string, toolCalls: Array<{
  input: Record<string, unknown>;
  reason: string;
  toolCallId: string;
  toolName: string;
}>): ProviderResponse {
  return {
    kind: "tool_calls",
    message,
    toolCalls,
    usage: {
      inputTokens: 10,
      outputTokens: 5
    }
  };
}

function finalResponse(message: string): ProviderResponse {
  return {
    kind: "final",
    message,
    usage: {
      inputTokens: 5,
      outputTokens: 5
    }
  };
}
