import { spawn } from "node:child_process";

import type { ScheduleNoAgentConfig } from "./schedule-metadata.js";

export interface NoAgentRunResult {
  output: string;
  success: boolean;
  errorMessage: string | null;
}

export function runNoAgentCommand(
  config: ScheduleNoAgentConfig,
  defaultCwd: string
): Promise<NoAgentRunResult> {
  return new Promise((resolve) => {
    const child = spawn(config.command, {
      cwd: config.cwd ?? defaultCwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({
        errorMessage: error.message,
        output: stdout,
        success: false
      });
    });
    child.on("close", (code) => {
      const output = stdout.trim().length > 0 ? stdout : stderr;
      resolve({
        errorMessage: code === 0 ? null : stderr || `Exit code ${String(code)}`,
        output,
        success: code === 0
      });
    });
  });
}
