import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ToolExposurePlanner } from "../src/runtime/tool-exposure-planner.js";
import { getToolInputSchemaDescriptor } from "../src/tools/schema/index.js";
import type { ToolOverrideStore } from "../src/tools/tool-overrides.js";
import type { ToolDefinition } from "../src/types/index.js";

function createDisabledToolOverrideStore(disabledToolNames: string[] = []): ToolOverrideStore {
  return {
    disableTool: () => ({ tools: [] }),
    enableTool: () => ({ tools: [] }),
    listDisabledToolNames: () => disabledToolNames,
    listTools: () => ({ tools: [] })
  } as ToolOverrideStore;
}

function makeTool(name: string, riskLevel: "low" | "medium" | "high"): ToolDefinition {
  return {
    capability: "filesystem.read",
    costLevel: "cheap",
    description: name,
    execute: () => Promise.resolve({ output: {}, success: true, summary: "ok" }),
    inputSchema: z.object({}),
    name,
    prepare: () => ({
      governance: { pathScope: "workspace", summary: "ok" },
      preparedInput: {},
      sandbox: {
        kind: "file",
        operation: "read",
        pathScope: "workspace",
        requestedPath: ".",
        resolvedPath: ".",
        withinExtraWriteRoot: false
      }
    }),
    privacyLevel: "internal",
    riskLevel,
    sideEffectLevel: "read_only",
    toolKind: "runtime_primitive"
  };
}

function createPlanner(tools: ToolDefinition[], disabledToolNames: string[] = []): ToolExposurePlanner {
  return new ToolExposurePlanner({
    budgetService: { isDowngradeActive: () => false } as never,
    toolOrchestrator: {
      listTools: (toolNames: string[] | undefined) =>
        tools
          .filter((tool) => toolNames === undefined || toolNames.includes(tool.name))
          .map((tool) => ({
            capability: tool.capability,
            description: tool.description,
            inputSchema: getToolInputSchemaDescriptor(tool),
            name: tool.name,
            privacyLevel: tool.privacyLevel,
            riskLevel: tool.riskLevel
          })),
      listToolsWithMetadata: () => tools
    } as never,
    toolOverrideStore: createDisabledToolOverrideStore(disabledToolNames),
    traceService: { record: vi.fn() } as never
  });
}

describe("tool exposure planner", () => {
  it("keeps all available tools exposed and emits trace data", async () => {
    const tools = [makeTool("read_file", "low"), makeTool("shell", "high")];
    const planner = createPlanner(tools);
    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-1",
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-1",
      sessionId: null
    });
    expect(plan.tools.map((tool) => tool.name)).toEqual(["read_file", "shell"]);
  });

  it("hides only tools that fail availability checks", async () => {
    const webFetch = makeTool("web_extract", "medium");
    webFetch.capability = "network.fetch_public_readonly";
    webFetch.sideEffectLevel = "external_read_only";
    webFetch.checkAvailability = () => ({ available: false, reason: "network disabled" });
    const tools = [makeTool("read_file", "low"), webFetch];
    const planner = createPlanner(tools);

    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-2",
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-2",
      sessionId: null
    });

    expect(plan.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    expect(plan.decisions.find((decision) => decision.toolName === "web_extract")).toMatchObject({
      exposed: false,
      reason: "unavailable: network disabled"
    });
  });

  it("excludes disabled tools before availability checks", async () => {
    const tools = [makeTool("read_file", "low"), makeTool("shell", "high")];
    const planner = createPlanner(tools, ["shell"]);
    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-3",
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-3",
      sessionId: null
    });

    expect(plan.tools.map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("filters tools by schedule toolsets including mcp tools", async () => {
    const readTool = makeTool("read_file", "low");
    const mcpTool = makeTool("mcp__server__search", "low");
    const shellTool = makeTool("shell", "high");
    const planner = createPlanner([readTool, mcpTool, shellTool]);
    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-mcp",
        taskMetadata: {
          scheduleToolsets: ["mcp"]
        },
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-mcp",
      sessionId: null
    });

    expect(plan.tools.map((tool) => tool.name)).toEqual(["mcp__server__search"]);
  });

  it("ignores invalid schedule toolset names", async () => {
    const tools = [makeTool("read_file", "low"), makeTool("shell", "high")];
    const planner = createPlanner(tools);
    const plan = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-invalid-toolset",
        taskMetadata: {
          scheduleToolsets: ["not-a-real-toolset"]
        },
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      iteration: 1,
      taskId: "task-invalid-toolset",
      sessionId: null
    });

    expect(plan.tools).toHaveLength(0);
  });

  it("limits plan mode to read-only tools", async () => {
    const readTool = makeTool("read_file", "low");
    const shellTool = makeTool("shell", "high");
    shellTool.sideEffectLevel = "external_mutation";
    const planner = createPlanner([readTool, shellTool]);
    const plan = await planner.plan({
      context: {
        agentProfileId: "planner",
        cwd: process.cwd(),
        iteration: 1,
        signal: new AbortController().signal,
        taskId: "task-4",
        userId: "u1",
        workspaceRoot: process.cwd()
      },
      interactionMode: "plan",
      iteration: 1,
      taskId: "task-4",
      sessionId: null
    });

    expect(plan.tools.map((tool) => tool.name)).toEqual(["read_file"]);
  });
});
