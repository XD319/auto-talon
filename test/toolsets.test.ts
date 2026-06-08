import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ToolOverrideStore } from "../src/tools/tool-overrides.js";
import {
  isPlanSafeTool,
  resolveToolsetForTool,
  TOOLSET_TOOLS
} from "../src/tools/toolsets.js";
import type { ToolDefinition } from "../src/types/index.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("toolsets", () => {
  it("maps canonical tools to expected toolsets", () => {
    expect(resolveToolsetForTool("read_file")).toBe("file");
    expect(resolveToolsetForTool("shell")).toBe("shell");
    expect(resolveToolsetForTool("web_extract")).toBe("web");
    expect(resolveToolsetForTool("clarify")).toBe("interaction");
    expect(resolveToolsetForTool("skills_list")).toBe("skills");
    expect(resolveToolsetForTool("session_search")).toBe("session");
    expect(resolveToolsetForTool("delegate_task")).toBe("agent");
    expect(resolveToolsetForTool("mcp__server__tool")).toBe("mcp");
  });

  it("defines the file toolset with canonical file tools", () => {
    expect(TOOLSET_TOOLS.file).toEqual([
      "read_file",
      "write_file",
      "patch",
      "search_files",
      "glob"
    ]);
  });

  it("treats read-only side effects as plan-safe", () => {
    expect(isPlanSafeTool(createTool("read_file", "read_only"))).toBe(true);
    expect(isPlanSafeTool(createTool("shell", "external_mutation"))).toBe(false);
  });
});

describe("tool overrides", () => {
  it("persists disabled tools in .auto-talon/tool-overrides.json", () => {
    const workspaceRoot = createTempWorkspace();
    const store = new ToolOverrideStore(workspaceRoot);
    const tools = [createTool("read_file", "read_only"), createTool("shell", "external_mutation")];

    store.disableTool("shell", tools);
    expect(store.listDisabledToolNames()).toEqual(["shell"]);
    expect(store.listTools(tools).tools.find((tool) => tool.name === "shell")?.disabled).toBe(true);

    store.enableTool("shell", tools);
    expect(store.listDisabledToolNames()).toEqual([]);
  });
});

function createTool(name: string, sideEffectLevel: ToolDefinition["sideEffectLevel"]): ToolDefinition {
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
    riskLevel: "low",
    sideEffectLevel,
    toolKind: "runtime_primitive"
  };
}

function createTempWorkspace(): string {
  const workspaceRoot = join(tmpdir(), `auto-talon-toolsets-${Date.now()}-${Math.random()}`);
  tempPaths.push(workspaceRoot);
  const configDir = join(workspaceRoot, ".auto-talon");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "tool-overrides.json"),
    `${JSON.stringify({ disabledToolNames: [] }, null, 2)}\n`,
    "utf8"
  );
  return workspaceRoot;
}
