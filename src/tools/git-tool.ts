import { z } from "zod";

import { AppError } from "../core/app-error.js";
import type { PreparedShellInput, SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import type { ShellCommandExecutor } from "./shell/shell-executor.js";

const gitToolSchema = z.object({
  action: z.enum(["status", "diff", "stage", "commit", "branch"]),
  message: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).optional(),
  target: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional()
});

type GitToolInput = z.infer<typeof gitToolSchema>;

type PreparedGitToolInput = PreparedShellInput & {
  action: GitToolInput["action"];
};

export class GitTool implements ToolDefinition<typeof gitToolSchema, PreparedGitToolInput> {
  public readonly name = "git";
  public readonly description =
    "Run structured git actions for delivery workflows: status, diff, stage, commit, and branch.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "cheap" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = gitToolSchema;

  public constructor(
    private readonly executor: ShellCommandExecutor,
    private readonly sandboxService: SandboxService
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    return { available: true, reason: "git executable is expected on PATH" };
  }

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedGitToolInput> {
    const parsedInput = this.inputSchema.parse(input);
    const command = buildGitCommand(parsedInput);
    const preparedInput = this.sandboxService.prepareShellExecution({
      command,
      cwd: context.cwd,
      ...(parsedInput.timeoutMs === undefined ? {} : { timeoutMs: parsedInput.timeoutMs })
    });

    return {
      governance: {
        pathScope: preparedInput.sandboxPlan.pathScope,
        summary: `Run git ${parsedInput.action}`
      },
      preparedInput: {
        ...preparedInput,
        action: parsedInput.action
      },
      sandbox: preparedInput.sandboxPlan
    };
  }

  public async execute(input: PreparedGitToolInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const result = await this.executor.execute({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal: context.signal,
      timeoutMs: input.timeoutMs
    });
    const output = {
      action: input.action,
      command: input.command,
      cwd: input.cwd,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      stderr: result.stderr,
      stderrPreview: summarizeOutput(result.stderr),
      stderrTruncated: result.stderrTruncated,
      stdout: result.stdout,
      stdoutPreview: summarizeOutput(result.stdout),
      stdoutTruncated: result.stdoutTruncated,
      timedOut: result.timedOut
    };

    if (result.exitCode !== 0 || result.timedOut) {
      return {
        details: output,
        errorCode: "tool_execution_error",
        errorMessage: `git ${input.action} failed with exit code ${result.exitCode}.`,
        success: false
      };
    }

    return {
      output,
      success: true,
      summary: `git ${input.action} completed.`
    };
  }
}

function buildGitCommand(input: GitToolInput): string {
  switch (input.action) {
    case "status":
      return "git status --short";
    case "diff":
      return input.paths === undefined || input.paths.length === 0
        ? "git diff --"
        : `git diff -- ${input.paths.map(shellQuote).join(" ")}`;
    case "stage":
      return input.paths === undefined || input.paths.length === 0
        ? "git add -A"
        : `git add -- ${input.paths.map(shellQuote).join(" ")}`;
    case "commit":
      if (input.message === undefined) {
        throw new AppError({
          code: "tool_validation_error",
          message: "git commit requires message."
        });
      }
      return `git commit -m ${shellQuote(input.message)}`;
    case "branch":
      if (input.target === undefined) {
        throw new AppError({
          code: "tool_validation_error",
          message: "git branch requires target."
        });
      }
      return `git switch -c ${shellQuote(input.target)}`;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function summarizeOutput(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 500)}...`;
}
