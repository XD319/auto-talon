import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { GitTool } from "../src/tools/git-tool.js";
import type { ShellCommandExecutor } from "../src/tools/shell/shell-executor.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("GitTool", () => {
  it("runs structured git status and stage commands", async () => {
    const seenCommands: string[] = [];
    const tool = new GitTool(mockExecutor(seenCommands), createSandboxService());

    const status = await tool.execute(tool.prepare({ action: "status" }, createContext()).preparedInput, createContext());
    const stage = await tool.execute(
      tool.prepare({ action: "stage", paths: ["src/index.ts", "docs/read me.md"] }, createContext()).preparedInput,
      createContext()
    );

    expect(status.success).toBe(true);
    expect(stage.success).toBe(true);
    expect(seenCommands).toEqual(["git status --short", "git add -- 'src/index.ts' 'docs/read me.md'"]);
  });

  it("quotes commit messages and reports git failures", async () => {
    const seenCommands: string[] = [];
    const tool = new GitTool(mockExecutor(seenCommands, { exitCode: 1, stderr: "nothing to commit" }), createSandboxService());

    const prepared = tool.prepare({ action: "commit", message: "it's done" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(seenCommands).toEqual(["git commit -m 'it''s done'"]);
    expect(result.success).toBe(false);
    expect(result.success ? null : result.errorMessage).toContain("git commit failed");
  });

  it("requires commit messages and branch targets", () => {
    const tool = new GitTool(mockExecutor([]), createSandboxService());

    expect(() => tool.prepare({ action: "commit" }, createContext())).toThrow("git commit requires message");
    expect(() => tool.prepare({ action: "branch" }, createContext())).toThrow("git branch requires target");
  });
});

function createSandboxService(): SandboxService {
  return new SandboxService({
    allowedShellCommands: ["git"],
    workspaceRoot: process.cwd()
  });
}

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-git",
    taskMetadata: {},
    userId: "user",
    workspaceRoot: process.cwd()
  };
}

function mockExecutor(
  seenCommands: string[],
  overrides: Partial<Awaited<ReturnType<ShellCommandExecutor["execute"]>>> = {}
): ShellCommandExecutor {
  return {
    execute: (request) => {
      seenCommands.push(request.command);
      return Promise.resolve({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stderrTruncated: false,
        stdout: "ok",
        stdoutTruncated: false,
        timedOut: false,
        ...overrides
      });
    }
  };
}
