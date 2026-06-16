import { spawn } from "node:child_process";

import type { ScheduleNoAgentConfig } from "./schedule-metadata.js";

export interface NoAgentRunResult {
  output: string;
  success: boolean;
  errorMessage: string | null;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 65_536;
const KILL_GRACE_MS = 5_000;

export function runNoAgentCommand(
  config: ScheduleNoAgentConfig,
  defaultCwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<NoAgentRunResult> {
  return new Promise((resolve) => {
    const parsed = parseCommand(config.command);
    const child = spawn(parsed.executable, parsed.args, {
      cwd: config.cwd ?? defaultCwd,
      shell: parsed.shell,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: NoAgentRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      finish({
        errorMessage: `Command timed out after ${String(timeoutMs)}ms`,
        output: truncateOutput(stdout, stderr),
        success: false
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendCapped(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendCapped(stderr, String(chunk));
    });
    child.on("error", (error) => {
      finish({
        errorMessage: error.message,
        output: truncateOutput(stdout, stderr),
        success: false
      });
    });
    child.on("close", (code) => {
      const output = truncateOutput(stdout, stderr);
      finish({
        errorMessage: code === 0 ? null : stderr.trim().length > 0 ? stderr.trim() : `Exit code ${String(code)}`,
        output,
        success: code === 0
      });
    });
  });
}

function parseCommand(command: string): { args: string[]; executable: string; shell: boolean } {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { args: [], executable: process.platform === "win32" ? "cmd.exe" : "sh", shell: false };
  }
  if (process.platform === "win32") {
    return { args: ["/d", "/s", "/c", trimmed], executable: "cmd.exe", shell: false };
  }
  const parts = trimmed.split(/\s+/u);
  const executable = parts[0] ?? trimmed;
  return {
    args: parts.slice(1),
    executable,
    shell: false
  };
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) {
    return current;
  }
  return (current + chunk).slice(0, MAX_OUTPUT_CHARS);
}

function truncateOutput(stdout: string, stderr: string): string {
  const output = stdout.trim().length > 0 ? stdout : stderr;
  return output.slice(0, MAX_OUTPUT_CHARS);
}
