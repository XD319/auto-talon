import { z } from "zod";

import type { AgentProfileId } from "../types/profile.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const delegateTaskSchema = z.object({
  maxIterations: z.number().int().positive().optional(),
  profile: z.enum(["planner", "executor", "reviewer"]).optional(),
  prompt: z.string().min(1)
});

export interface DelegateTaskRequest {
  cwd: string;
  maxIterations?: number;
  parentTaskId: string;
  profile?: AgentProfileId;
  prompt: string;
  signal: AbortSignal;
  userId: string;
}

export interface DelegateTaskResult {
  output: string | null;
  status: string;
  taskId: string;
}

export type DelegateTaskExecutor = (request: DelegateTaskRequest) => Promise<DelegateTaskResult>;

export interface PreparedDelegateTaskInput {
  maxIterations?: number;
  profile?: AgentProfileId;
  prompt: string;
}

export class DelegateTaskTool
  implements ToolDefinition<typeof delegateTaskSchema, PreparedDelegateTaskInput>
{
  public readonly name = "delegate_task";
  public readonly description =
    "Run a focused child agent task with its own iteration budget and return the final output.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "expensive" as const;
  public readonly sideEffectLevel = "none" as const;
  public readonly toolKind = "control_command" as const;
  public readonly inputSchema = delegateTaskSchema;

  private executor: DelegateTaskExecutor | null = null;

  public bindExecutor(executor: DelegateTaskExecutor): void {
    this.executor = executor;
  }

  public prepare(input: unknown): ToolPreparation<PreparedDelegateTaskInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: `Delegate task: ${parsed.prompt.slice(0, 120)}`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "prompt",
        pathScope: "workspace",
        target: "delegate_task"
      }
    };
  }

  public async execute(
    preparedInput: PreparedDelegateTaskInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (this.executor === null) {
      return {
        errorCode: "tool_unavailable",
        errorMessage: "delegate_task is not configured for this runtime.",
        success: false
      };
    }

    const result = await this.executor({
      cwd: context.cwd,
      maxIterations: preparedInput.maxIterations,
      parentTaskId: context.taskId,
      profile: preparedInput.profile,
      prompt: preparedInput.prompt,
      signal: context.signal,
      userId: context.userId
    });

    return {
      output: {
        output: result.output,
        parentTaskId: context.taskId,
        status: result.status,
        taskId: result.taskId
      },
      success: true,
      summary: `Delegated task ${result.taskId} finished with status ${result.status}`
    };
  }
}
