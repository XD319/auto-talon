import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { ProcessTool } from "../src/tools/process-tool.js";
import { TerminalSessionManager } from "../src/tools/terminal-session-manager.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("process tool", () => {
  it("resolves named long-running commands before sandbox preparation", () => {
    const workspace = createWorkspace();
    const manager = new TerminalSessionManager();
    const sandbox = new SandboxService({
      allowedEnvKeys: ["NODE_ENV", "PORT"],
      allowedShellCommands: ["node"],
      workspaceRoot: workspace
    });
    const context = createContext(workspace);
    const processTool = new ProcessTool(manager, sandbox, [
      {
        command: "node server.cjs",
        env: {
          PORT: "4321"
        },
        name: "dev"
      }
    ]);

    try {
      const prepared = processTool
        .prepare({ action: "start", env: { NODE_ENV: "development" }, name: "dev" }, context)
        .preparedInput;
      if (prepared.action !== "start") {
        throw new Error("Expected start action.");
      }

      expect(prepared.preparedShell.command).toBe("node server.cjs");
      expect(prepared.preparedShell.cwd).toBe(workspace);
      expect(prepared.preparedShell.env).toEqual({
        NODE_ENV: "development",
        PORT: "4321"
      });
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("starts, reads, writes, and stops a long-running process session", async () => {
    const workspace = createWorkspace();
    writeFileSync(
      join(workspace, "terminal-fixture.cjs"),
      [
        "process.stdin.setEncoding('utf8');",
        "console.log('ready');",
        "process.stdin.on('data', (chunk) => {",
        "  console.log(`echo:${chunk.trim()}`);",
        "  if (chunk.includes('quit')) process.exit(0);",
        "});",
        "setInterval(() => undefined, 1000);"
      ].join("\n"),
      "utf8"
    );
    const manager = new TerminalSessionManager();
    const sandbox = new SandboxService({ allowedShellCommands: ["node"], workspaceRoot: workspace });
    const context = createContext(workspace);
    const processTool = new ProcessTool(manager, sandbox);

    try {
      const started = await processTool.execute(
        processTool.prepare({ action: "start", command: "node terminal-fixture.cjs" }, context).preparedInput
      );
      expect(started.success).toBe(true);
      if (!started.success) {
        throw new Error("process start failed");
      }
      const sessionId = (started.output as { sessionId: string }).sessionId;

      await expect(
        readUntil(processTool, sessionId, "ready")
      ).resolves.toContain("ready");

      await processTool.execute({ action: "write", data: "hello\n", sessionId });
      await expect(
        readUntil(processTool, sessionId, "echo:hello")
      ).resolves.toContain("echo:hello");

      await processTool.execute({ action: "write", data: "quit\n", sessionId });
      await delay(500);
      const stopped = await processTool.execute({ action: "stop", sessionId });
      expect(stopped.success && (stopped.output as { running: boolean }).running).toBe(false);
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});

function createWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "auto-talon-process-"));
}

function cleanupWorkspace(workspace: string): void {
  rmSync(workspace, { force: true, recursive: true });
}

function createContext(workspace: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: workspace,
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-process",
    userId: "user-1",
    workspaceRoot: workspace
  };
}

async function readUntil(
  processTool: ProcessTool,
  sessionId: string,
  needle: string,
  attempts = 20
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await processTool.execute({ action: "read", sessionId });
    if (!result.success) {
      throw new Error("process read failed");
    }
    const text = JSON.stringify(result.output);
    if (text.includes(needle)) {
      return text;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${needle}`);
}
