import { z } from "zod";

import type { PreparedShellInput, SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import type { TerminalSessionManager } from "./terminal-session-manager.js";

interface LongRunningCommandConfig {
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  name: string;
}

const processSchema = z
  .object({
    action: z.enum(["start", "read", "write", "stop"]),
    command: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    data: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional()
  })
  .superRefine((input, ctx) => {
    if (input.action === "start" && input.command === undefined && input.name === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "process start requires either command or name."
      });
    }
    if (input.action !== "start" && input.sessionId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `process ${input.action} requires sessionId.`
      });
    }
    if (input.action === "write" && input.data === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "process write requires data."
      });
    }
  });

type ProcessInput = z.infer<typeof processSchema>;

type PreparedProcessInput =
  | { action: "start"; preparedShell: PreparedShellInput }
  | { action: "read"; sessionId: string }
  | { action: "write"; data: string; sessionId: string }
  | { action: "stop"; sessionId: string };

export class ProcessTool implements ToolDefinition<typeof processSchema, PreparedProcessInput> {
  public readonly name = "process";
  public readonly description =
    "Manage long-running terminal processes: start, read buffered output, write stdin, or stop a session.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "moderate" as const;
  public readonly sideEffectLevel = "external_mutation" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = processSchema;

  public constructor(
    private readonly manager: TerminalSessionManager,
    private readonly sandboxService: SandboxService,
    private readonly longRunningCommands: LongRunningCommandConfig[] = []
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    return { available: true, reason: "terminal session manager available" };
  }

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedProcessInput> {
    const parsedInput = this.inputSchema.parse(input);

    if (parsedInput.action === "start") {
      const configuredCommand = parsedInput.name === undefined
        ? undefined
        : this.longRunningCommands.find((command) => command.name === parsedInput.name);
      if (parsedInput.command === undefined && configuredCommand === undefined) {
        throw new Error(`Unknown long-running command '${parsedInput.name ?? "-"}'.`);
      }
      const command = parsedInput.command ?? configuredCommand?.command;
      if (command === undefined) {
        throw new Error("process start could not resolve a command.");
      }
      const env = {
        ...(configuredCommand?.env ?? {}),
        ...(parsedInput.env ?? {})
      };
      const sandboxRequest: { command: string; cwd: string; env?: Record<string, string> } = {
        command,
        cwd: parsedInput.cwd ?? configuredCommand?.cwd ?? context.cwd
      };
      if (Object.keys(env).length > 0) {
        sandboxRequest.env = env;
      }
      const preparedShell = this.sandboxService.prepareShellExecution(sandboxRequest);
      return {
        governance: {
          pathScope: preparedShell.sandboxPlan.pathScope,
          summary: `Start process ${preparedShell.command}`
        },
        preparedInput: { action: "start", preparedShell },
        sandbox: preparedShell.sandboxPlan
      };
    }

    const sessionId = parsedInput.sessionId!;
    const summary = summarizeAction(parsedInput.action, sessionId);
    return {
      governance: {
        pathScope: "workspace",
        summary
      },
      preparedInput:
        parsedInput.action === "write"
          ? { action: "write", data: parsedInput.data!, sessionId }
          : parsedInput.action === "read"
            ? { action: "read", sessionId }
            : { action: "stop", sessionId },
      sandbox: {
        kind: "prompt",
        pathScope: "workspace",
        target: "interactive_user"
      }
    };
  }

  public execute(input: PreparedProcessInput): Promise<ToolExecutionResult> {
    switch (input.action) {
      case "start": {
        const session = this.manager.start({
          command: input.preparedShell.command,
          cwd: input.preparedShell.cwd,
          env: input.preparedShell.env
        });
        return Promise.resolve({
          output: { ...session },
          success: true,
          summary: `Started process session ${session.sessionId}.`
        });
      }
      case "read": {
        const output = this.manager.read(input.sessionId);
        return Promise.resolve({
          output: { ...output },
          success: true,
          summary: summarizeReadOutput(input.sessionId, output)
        });
      }
      case "write": {
        const output = this.manager.write(input.sessionId, input.data);
        return Promise.resolve({
          output: { ...output },
          success: true,
          summary: `Wrote to process session ${input.sessionId}.`
        });
      }
      case "stop": {
        const output = this.manager.stop(input.sessionId);
        return Promise.resolve({
          output: { ...output },
          success: true,
          summary: `Stopped process session ${input.sessionId}.`
        });
      }
    }
  }
}

function summarizeAction(action: ProcessInput["action"], sessionId: string): string {
  switch (action) {
    case "read":
      return `Read process session ${sessionId}`;
    case "write":
      return `Write to process session ${sessionId}`;
    case "stop":
      return `Stop process session ${sessionId}`;
    default:
      return `Process session ${sessionId}`;
  }
}

function summarizeReadOutput(
  sessionId: string,
  output: { exitCode: number | null; running: boolean; stderr: string }
): string {
  if (output.running) {
    return `Read process session ${sessionId}.`;
  }
  const stderrSummary = summarizeStderr(output.stderr);
  return `Read process session ${sessionId}; process exited with code ${output.exitCode ?? "unknown"}${
    stderrSummary.length > 0 ? `; stderr: ${stderrSummary}` : ""
  }.`;
}

function summarizeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const lines = trimmed.split(/\r?\n/u).slice(-3);
  const joined = lines.join(" | ").replace(/\s+/gu, " ").trim();
  return joined.length > 240 ? `${joined.slice(0, 240)}...` : joined;
}
