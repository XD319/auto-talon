import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import { ToolOrchestrator } from "../src/tools/tool-orchestrator.js";
import {
  buildParallelSafeLookup,
  groupToolCallsIntoBatches,
  isParallelSafeTool
} from "../src/tools/tool-parallel-policy.js";
import type {
  Provider,
  ProviderInput,
  ProviderResponse,
  ProviderToolCall,
  ToolDefinition
} from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "parallel-tools-provider";

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

const readTool = (name: string): ToolDefinition =>
  ({
    capability: "filesystem.read",
    description: name,
    execute: () => Promise.resolve({ output: { ok: true }, success: true, summary: name }),
    inputSchema: { safeParse: (value: unknown) => ({ data: value, success: true }) },
    name,
    prepare: () =>
      Promise.resolve({
        governance: { pathScope: "workspace", summary: name },
        preparedInput: {},
        sandbox: { kind: "file", operation: "read", pathScope: "workspace", resolvedPath: "a.txt" }
      }),
    privacyLevel: "internal",
    riskLevel: "low",
    sideEffectLevel: "read_only"
  }) as unknown as ToolDefinition;

const writeTool = (name: string): ToolDefinition =>
  ({
    capability: "filesystem.write",
    description: name,
    execute: () => Promise.resolve({ output: { ok: true }, success: true, summary: name }),
    inputSchema: { safeParse: (value: unknown) => ({ data: value, success: true }) },
    name,
    prepare: () =>
      Promise.resolve({
        governance: { pathScope: "workspace", summary: name },
        preparedInput: {},
        sandbox: { kind: "file", operation: "write", pathScope: "workspace", resolvedPath: "a.txt" }
      }),
    privacyLevel: "internal",
    riskLevel: "high",
    sideEffectLevel: "workspace_mutation"
  }) as unknown as ToolDefinition;

const clarifyTool = (): ToolDefinition =>
  ({
    capability: "interaction.ask_user",
    description: "clarify",
    execute: () => Promise.resolve({ output: { ok: true }, success: true, summary: "clarify" }),
    inputSchema: { safeParse: (value: unknown) => ({ data: value, success: true }) },
    name: "clarify",
    prepare: () =>
      Promise.resolve({
        governance: { pathScope: "workspace", summary: "clarify" },
        preparedInput: { question: "Which option?" },
        sandbox: { kind: "prompt", target: "clarify" }
      }),
    privacyLevel: "internal",
    riskLevel: "low",
    sideEffectLevel: "none"
  }) as unknown as ToolDefinition;

const toolCall = (toolCallId: string, toolName: string): ProviderToolCall => ({
  input: { path: `${toolCallId}.txt` },
  reason: "test",
  toolCallId,
  toolName
});

describe("tool parallel policy", () => {
  it("classifies read-only tools as parallel-safe and mutations as serial-only", () => {
    expect(isParallelSafeTool(readTool("read_file"))).toBe(true);
    expect(isParallelSafeTool(writeTool("write_file"))).toBe(false);
    expect(isParallelSafeTool(clarifyTool())).toBe(false);
  });

  it("groups consecutive parallel-safe calls and isolates serial tools", () => {
    const lookup = buildParallelSafeLookup([
      readTool("read_a"),
      readTool("read_b"),
      writeTool("write_file"),
      readTool("read_c"),
      clarifyTool()
    ]);
    const isParallelSafe = (toolName: string) => lookup.get(toolName) ?? false;

    const batches = groupToolCallsIntoBatches(
      [
        toolCall("call-1", "read_a"),
        toolCall("call-2", "read_b"),
        toolCall("call-3", "write_file"),
        toolCall("call-4", "read_c"),
        toolCall("call-5", "clarify")
      ],
      isParallelSafe
    );

    expect(batches).toEqual([
      {
        kind: "parallel",
        toolCalls: [toolCall("call-1", "read_a"), toolCall("call-2", "read_b")]
      },
      { kind: "serial", toolCall: toolCall("call-3", "write_file") },
      { kind: "parallel", toolCalls: [toolCall("call-4", "read_c")] },
      { kind: "serial", toolCall: toolCall("call-5", "clarify") }
    ]);
  });
});

describe("execution kernel parallel read tools", () => {
  it("executes consecutive read-only tool calls concurrently", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(join(workspaceRoot, "a.txt"), "alpha", "utf8");
    await fs.writeFile(join(workspaceRoot, "b.txt"), "beta", "utf8");
    await fs.writeFile(join(workspaceRoot, "c.txt"), "gamma", "utf8");

    let generation = 0;
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider(() => {
        generation += 1;
        if (generation === 1) {
          return {
            kind: "tool_calls",
            message: "Read three files.",
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
              },
              {
                input: { path: "c.txt" },
                reason: "Read c",
                toolCallId: "read-c",
                toolName: "read_file"
              }
            ],
            usage: { inputTokens: 8, outputTokens: 4 }
          };
        }
        return {
          kind: "final",
          message: "All files read.",
          usage: { inputTokens: 4, outputTokens: 2 }
        };
      })
    });

    const originalExecute = ToolOrchestrator.prototype.execute;
    let activeExecutions = 0;
    let maxConcurrentExecutions = 0;
    const executeSpy = vi
      .spyOn(ToolOrchestrator.prototype, "execute")
      .mockImplementation(async function (this: ToolOrchestrator, request, context) {
        if (request.toolName === "read_file") {
          activeExecutions += 1;
          maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions);
          await new Promise((resolve) => setTimeout(resolve, 40));
          activeExecutions -= 1;
        }
        return originalExecute.call(this, request, context);
      });

    try {
      const options = createDefaultRunOptions("parallel reads", workspaceRoot, handle.config);
      const result = await handle.service.runTask(options);

      expect(result.error).toBeUndefined();
      expect(result.output).toContain("All files read.");
      expect(executeSpy.mock.calls.filter(([request]) => request.toolName === "read_file")).toHaveLength(
        3
      );
      expect(maxConcurrentExecutions).toBeGreaterThan(1);

      const details = handle.service.showTask(result.task.taskId);
      expect(details.toolCalls.map((call) => call.toolCallId)).toEqual(["read-a", "read-b", "read-c"]);
      expect(details.toolCalls.every((call) => call.status === "finished")).toBe(true);
    } finally {
      executeSpy.mockRestore();
      handle.close();
    }
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = join(
    tmpdir(),
    `auto-talon-parallel-tools-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  tempPaths.push(workspaceRoot);
  await fs.mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}
