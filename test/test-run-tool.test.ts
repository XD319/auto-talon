import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { TestRunTool } from "../src/tools/test-run-tool.js";
import type { ShellCommandExecutor } from "../src/tools/shell/shell-executor.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("TestRunTool", () => {
  it("resolves named command groups and default timeouts", async () => {
    const seenRequests: Array<{ command: string; timeoutMs: number }> = [];
    const tool = new TestRunTool(
      {
        execute: (request) => {
          seenRequests.push({
            command: request.command,
            timeoutMs: request.timeoutMs
          });
          return Promise.resolve({
            durationMs: 1,
            exitCode: 0,
            stderr: "",
            stderrTruncated: false,
            stdout: "ok",
            stdoutTruncated: false,
            timedOut: false
          });
        }
      },
      createSandboxService(),
      [
        {
          category: "test",
          command: "node check.js",
          name: "test",
          timeoutMs: 90_000
        }
      ],
      2
    );

    const prepared = tool.prepare({ command: "test" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    expect(seenRequests).toEqual([
      {
        command: "node check.js",
        timeoutMs: 90_000
      }
    ]);
    expect(result.success && result.output).toMatchObject({
      command: "node check.js",
      commandCategory: "test",
      commandName: "test",
      passed: true
    });
  });

  it("classifies failures and suggests a next step", async () => {
    const tool = new TestRunTool(
      mockExecutor({
        exitCode: 1,
        stderr: "AssertionError: expected true to be false"
      }),
      createSandboxService(),
      ["node check.js"],
      2
    );

    const prepared = tool.prepare({ command: "node check.js" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected repairable test failure to be returned as success.");
    }
    expect(result.output).toMatchObject({
      failureCategory: "assertion_failure",
      passed: false
    });
    expect(JSON.stringify(result.output)).toContain("rerun this command");
  });
});

function createSandboxService(): SandboxService {
  return new SandboxService({
    allowedShellCommands: ["node"],
    maxShellTimeoutMs: 120_000,
    workspaceRoot: process.cwd()
  });
}

function mockExecutor(overrides: Partial<Awaited<ReturnType<ShellCommandExecutor["execute"]>>>): ShellCommandExecutor {
  return {
    execute: () =>
      Promise.resolve({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stderrTruncated: false,
        stdout: "ok",
        stdoutTruncated: false,
        timedOut: false,
        ...overrides
      })
  };
}

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-test-run-tool-test",
    userId: "test-user",
    workspaceRoot: process.cwd()
  };
}
