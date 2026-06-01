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

const testRunSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional()
});

type PreparedTestRunInput = PreparedShellInput;

export type TestCommandConfig =
  | string
  | {
      category?: "build" | "lint" | "test" | "typecheck" | "other" | undefined;
      command: string;
      name: string;
      timeoutMs?: number | undefined;
    };

interface NormalizedTestCommand {
  category: "build" | "lint" | "test" | "typecheck" | "other";
  command: string;
  name: string;
  timeoutMs?: number;
}

type PreparedTestRunInputWithMetadata = PreparedTestRunInput & {
  commandCategory: NormalizedTestCommand["category"];
  commandName: string;
};

export class TestRunTool implements ToolDefinition<typeof testRunSchema, PreparedTestRunInputWithMetadata> {
  public readonly name = "test_run";
  public readonly description =
    "Run a configured test or build command and return structured pass/fail output for repair loops.";
  public readonly capability = "shell.execute" as const;
  public readonly riskLevel = "high" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "moderate" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = testRunSchema;
  private readonly failedAttemptsByTaskId = new Map<string, number>();
  private readonly configuredCommands: NormalizedTestCommand[];

  public constructor(
    private readonly executor: ShellCommandExecutor,
    private readonly sandboxService: SandboxService,
    allowedCommands: TestCommandConfig[],
    private readonly maxRepairAttempts: number
  ) {
    this.configuredCommands = allowedCommands.map(normalizeTestCommandConfig);
  }

  public checkAvailability(): ToolAvailabilityResult {
    return this.configuredCommands.length > 0
      ? { available: true, reason: "test commands configured" }
      : { available: false, reason: "no test commands configured" };
  }

  public get inputSchemaDescriptor(): ToolDefinition<typeof testRunSchema, PreparedTestRunInputWithMetadata>["inputSchemaDescriptor"] {
    return {
      properties: {
        command: {
          enum: allowedCommandInputs(this.configuredCommands),
          type: "string"
        },
        timeoutMs: {
          type: "number"
        }
      },
      required: ["command"],
      type: "object"
    };
  }

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedTestRunInputWithMetadata> {
    const parsedInput = this.inputSchema.parse(input);
    const requestedCommand = parsedInput.command.trim();
    const configuredCommand = resolveConfiguredCommand(requestedCommand, this.configuredCommands);
    if (configuredCommand === null) {
      throw new AppError({
        code: "tool_validation_error",
        details: {
          allowedCommands: allowedCommandInputs(this.configuredCommands)
        },
        message: `test_run command "${requestedCommand}" is not configured.`
      });
    }

    const preparedInput = this.sandboxService.prepareShellExecution({
      command: configuredCommand.command,
      cwd: context.cwd,
      ...resolveTimeoutInput(parsedInput.timeoutMs, configuredCommand.timeoutMs)
    });

    return {
      governance: {
        pathScope: preparedInput.sandboxPlan.pathScope,
        summary: `Run configured test command ${configuredCommand.name}`
      },
      preparedInput: {
        ...preparedInput,
        commandCategory: configuredCommand.category,
        commandName: configuredCommand.name
      },
      sandbox: preparedInput.sandboxPlan
    };
  }

  public async execute(
    input: PreparedTestRunInputWithMetadata,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const result = await this.executor.execute({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
      signal: context.signal,
      timeoutMs: input.timeoutMs
    });
    const passed = result.exitCode === 0 && !result.timedOut;
    const priorFailures = this.failedAttemptsByTaskId.get(context.taskId) ?? 0;
    const failedAttempts = passed ? 0 : priorFailures + 1;
    if (passed) {
      this.failedAttemptsByTaskId.delete(context.taskId);
    } else {
      this.failedAttemptsByTaskId.set(context.taskId, failedAttempts);
    }

    const output = {
      command: input.command,
      commandCategory: input.commandCategory,
      commandName: input.commandName,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      failedAttempts,
      failureCategory: passed ? null : classifyFailure(result.exitCode, result.timedOut, result.stdout, result.stderr),
      maxRepairAttempts: this.maxRepairAttempts,
      passed,
      stderr: result.stderr,
      stderrPreview: summarize(result.stderr),
      stdout: result.stdout,
      stdoutPreview: summarize(result.stdout),
      suggestedNextStep: passed ? null : suggestNextStep(result.exitCode, result.timedOut, result.stdout, result.stderr),
      timedOut: result.timedOut
    };

    if (!passed && failedAttempts > this.maxRepairAttempts) {
      return {
        details: output,
        errorCode: "tool_execution_error",
        errorMessage: `Configured test command "${input.commandName}" failed after ${failedAttempts} attempts.`,
        success: false
      };
    }

    return {
      artifacts: [
        {
          artifactType: "test_run",
          content: output,
          uri: `test:${input.command}`
        }
      ],
      output,
      success: true,
      summary: passed
        ? `Configured test command "${input.commandName}" passed.`
        : `Configured test command "${input.commandName}" failed; repair attempt ${failedAttempts}/${this.maxRepairAttempts}.`
    };
  }
}

function normalizeTestCommandConfig(command: TestCommandConfig): NormalizedTestCommand {
  if (typeof command === "string") {
    return {
      category: inferCommandCategory(command, command),
      command,
      name: command
    };
  }
  return {
    category: command.category ?? inferCommandCategory(command.name, command.command),
    command: command.command,
    name: command.name,
    ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {})
  };
}

function allowedCommandInputs(commands: NormalizedTestCommand[]): string[] {
  return [...new Set(commands.flatMap((command) => [command.name, command.command]))];
}

function resolveConfiguredCommand(
  requestedCommand: string,
  commands: NormalizedTestCommand[]
): NormalizedTestCommand | null {
  return commands.find((command) => command.name === requestedCommand || command.command === requestedCommand) ?? null;
}

function resolveTimeoutInput(
  requestedTimeoutMs: number | undefined,
  configuredTimeoutMs: number | undefined
): { timeoutMs?: number } {
  const timeoutMs = requestedTimeoutMs ?? configuredTimeoutMs;
  return timeoutMs === undefined ? {} : { timeoutMs };
}

function inferCommandCategory(
  name: string,
  command: string
): NormalizedTestCommand["category"] {
  const compact = `${name} ${command}`.toLowerCase();
  if (compact.includes("lint")) {
    return "lint";
  }
  if (compact.includes("typecheck") || compact.includes("tsc")) {
    return "typecheck";
  }
  if (compact.includes("build")) {
    return "build";
  }
  if (compact.includes("test") || compact.includes("vitest") || compact.includes("jest")) {
    return "test";
  }
  return "other";
}

function classifyFailure(
  exitCode: number,
  timedOut: boolean,
  stdout: string,
  stderr: string
): "assertion_failure" | "command_error" | "compile_error" | "timeout" {
  if (timedOut) {
    return "timeout";
  }
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  if (combined.includes("typescript") || combined.includes("tsc") || combined.includes("syntaxerror")) {
    return "compile_error";
  }
  if (combined.includes("assert") || combined.includes("expected") || combined.includes("failed")) {
    return "assertion_failure";
  }
  return exitCode === 0 ? "command_error" : "command_error";
}

function suggestNextStep(
  exitCode: number,
  timedOut: boolean,
  stdout: string,
  stderr: string
): string {
  const failureCategory = classifyFailure(exitCode, timedOut, stdout, stderr);
  switch (failureCategory) {
    case "timeout":
      return "Inspect partial output, then rerun a narrower command or increase timeoutMs if the command is expected to be long-running.";
    case "compile_error":
      return "Fix the reported compile or syntax errors, then rerun this command.";
    case "assertion_failure":
      return "Read the failing assertion and related source, update the implementation or test, then rerun this command.";
    case "command_error":
      return "Inspect stdout/stderr for the command failure, fix the underlying issue, then rerun this command.";
  }
}

function summarize(value: string): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= 500 ? compact : `${compact.slice(0, 500)}...`;
}
