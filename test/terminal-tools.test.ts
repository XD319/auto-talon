import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { TerminalSessionManager } from "../src/tools/terminal-session-manager.js";
import {
  TerminalReadTool,
  TerminalStartTool,
  TerminalStopTool,
  TerminalWriteTool
} from "../src/tools/terminal-tools.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("terminal session tools", () => {
  it("starts, reads, writes, and stops a long-running terminal session", async () => {
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
    const start = new TerminalStartTool(manager, sandbox);
    const read = new TerminalReadTool(manager);
    const write = new TerminalWriteTool(manager);
    const stop = new TerminalStopTool(manager);

    try {
      const started = await start.execute(
        start.prepare({ command: "node terminal-fixture.cjs" }, context).preparedInput
      );
      expect(started.success).toBe(true);
      if (!started.success) {
        throw new Error("terminal_start failed");
      }
      const sessionId = (started.output as { sessionId: string }).sessionId;

      await expect(readUntil(read, sessionId, "ready")).resolves.toContain("ready");

      await write.execute({ data: "hello\n", sessionId });
      await expect(readUntil(read, sessionId, "echo:hello")).resolves.toContain("echo:hello");

      await write.execute({ data: "quit\n", sessionId });
      await delay(500);
      const stopped = await stop.execute({ sessionId });
      expect(stopped.success && (stopped.output as { running: boolean }).running).toBe(false);
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});

function createWorkspace(): string {
  const tempRoot = process.platform === "win32"
    ? "D:\\tmp\\auto-talon-tests"
    : join(tmpdir(), "auto-talon-tests");
  mkdirSync(tempRoot, { recursive: true });
  return mkdtempSync(join(tempRoot, "terminal-tools-"));
}

function createContext(workspace: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: workspace,
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-terminal",
    taskMetadata: {},
    userId: "user",
    workspaceRoot: workspace
  };
}

function cleanupWorkspace(workspace: string): void {
  try {
    rmSync(workspace, { force: true, recursive: true });
  } catch {
    // Windows can briefly keep a child-process cwd handle open after process exit.
  }
}

async function readUntil(read: TerminalReadTool, sessionId: string, needle: string): Promise<string> {
  let output = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await delay(200);
    const result = await read.execute({ sessionId });
    if (result.success) {
      const chunk = result.output as { stderr: string; stdout: string };
      output += chunk.stdout;
      output += chunk.stderr;
      if (output.includes(needle)) {
        return output;
      }
    }
  }
  return output;
}
