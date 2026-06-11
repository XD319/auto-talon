import { spawn } from "node:child_process";
import { homedir } from "node:os";

import type { ResolvedProviderConfig } from "../providers/config.js";
import type { TuiStatusLineConfig } from "../runtime/tui-status-line-config.js";
import type { TuiInteractionMode } from "../types/runtime.js";
import { formatInteractionMode, formatModelShortName } from "./status-line-model.js";
import type { GitBranchStatus } from "./workspace-git-status.js";
import type { UiRunState } from "./ui-status.js";

export interface StatusLinePayload {
  cost: {
    total_cost_usd: number;
  };
  context_window: {
    context_window_size: number;
    total_input_tokens: number;
    used_percentage: number;
  };
  cwd: string;
  interaction_mode: string;
  model: {
    display_name: string;
    id: string;
  };
  render_width_chars: number;
  run_state: UiRunState;
  session_id: string | null;
  workspace: {
    current_dir: string;
    git_branch: string | null;
    git_dirty: boolean;
  };
}

export interface BuildStatusLinePayloadInput {
  cwd: string;
  gitStatus: GitBranchStatus | null;
  inputLimit: number;
  interactionMode: TuiInteractionMode;
  provider: ResolvedProviderConfig;
  renderWidthChars: number;
  reservedOutput: number;
  runState: UiRunState;
  sessionId: string | null;
  tokenHud: {
    contextPercent: number;
    estimatedCostUsd: number;
    inputTokens: number;
  };
}

export interface StatusLineCommandResult {
  error: string | null;
  ok: boolean;
  text: string | null;
}

let lastCommandRunAt = 0;

export function resetStatusLineCommandThrottle(): void {
  lastCommandRunAt = 0;
}

export function buildStatusLinePayload(input: BuildStatusLinePayloadInput): StatusLinePayload {
  const effectiveLimit = Math.max(input.inputLimit - input.reservedOutput, 1);
  return {
    cost: {
      total_cost_usd: input.tokenHud.estimatedCostUsd
    },
    context_window: {
      context_window_size: effectiveLimit,
      total_input_tokens: input.tokenHud.inputTokens,
      used_percentage: input.tokenHud.contextPercent
    },
    cwd: input.cwd,
    interaction_mode: formatInteractionMode(input.interactionMode),
    model: {
      display_name: formatModelShortName(input.provider),
      id: input.provider.model ?? input.provider.name
    },
    render_width_chars: input.renderWidthChars,
    run_state: input.runState,
    session_id: input.sessionId,
    workspace: {
      current_dir: input.cwd,
      git_branch: input.gitStatus?.branch ?? null,
      git_dirty: input.gitStatus?.dirty ?? false
    }
  };
}

export async function runStatusLineCommand(
  config: TuiStatusLineConfig,
  payload: StatusLinePayload,
  now = Date.now()
): Promise<StatusLineCommandResult> {
  const command = config.command?.trim() ?? "";
  if (command.length === 0) {
    return { error: "status line command is not configured", ok: false, text: null };
  }

  const minInterval = Math.max(300, config.updateIntervalMs);
  if (now - lastCommandRunAt < minInterval) {
    return { error: "throttled", ok: false, text: null };
  }
  lastCommandRunAt = now;

  const expanded = expandHome(command);
  const useShell = process.platform === "win32";
  const { args, executable } = useShell ? { args: [], executable: expanded } : splitCommand(expanded);

  return await new Promise<StatusLineCommandResult>((resolve) => {
    const child = spawn(executable, args, {
      env: process.env,
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: StatusLineCommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ error: "status line command timed out", ok: false, text: null });
    }, config.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({
        error: error.message,
        ok: false,
        text: null
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({
          error: stderr.trim().length > 0 ? stderr.trim() : `exit code ${code ?? "unknown"}`,
          ok: false,
          text: null
        });
        return;
      }

      const text = stdout.replace(/\s+/gu, " ").trim();
      finish({
        error: null,
        ok: text.length > 0,
        text: text.length > 0 ? text : null
      });
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function expandHome(command: string): string {
  if (!command.startsWith("~")) {
    return command;
  }
  return joinPath(homedir(), command.slice(1));
}

function joinPath(left: string, right: string): string {
  if (right.startsWith("/") || right.startsWith("\\")) {
    return `${left}${right}`;
  }
  return `${left}/${right}`;
}

function splitCommand(command: string): { args: string[]; executable: string } {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [command];
  const normalized = parts.map((part) => part.replace(/^['"]|['"]$/gu, ""));
  const executable = normalized[0] ?? command;
  return {
    args: normalized.slice(1),
    executable
  };
}
