import { z } from "zod";

import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import { executeGlob } from "./file/executors.js";

const globSchema = z.object({
  maxResults: z.number().int().positive().max(500).default(100),
  path: z.string().min(1),
  pattern: z.string().min(1).optional(),
  recursive: z.boolean().default(true)
});

export interface PreparedGlobInput {
  maxResults: number;
  pattern: string | null;
  plan: SandboxFileAccessPlan;
  recursive: boolean;
}

export class GlobTool implements ToolDefinition<typeof globSchema, PreparedGlobInput> {
  public readonly name = "glob";
  public readonly description =
    "List a directory or find files matching a glob pattern inside the workspace.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = globSchema;

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedGlobInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileRead(parsedInput.path, context.cwd);
    const summary =
      parsedInput.pattern === undefined
        ? `List directory ${plan.resolvedPath}`
        : `Glob "${parsedInput.pattern}" under ${plan.resolvedPath}`;

    return {
      governance: {
        pathScope: plan.pathScope,
        summary
      },
      preparedInput: {
        maxResults: parsedInput.maxResults,
        pattern: parsedInput.pattern ?? null,
        plan,
        recursive: parsedInput.recursive
      },
      sandbox: plan
    };
  }

  public async execute(input: PreparedGlobInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    return executeGlob(
      input.plan,
      input.pattern,
      input.recursive,
      input.maxResults,
      context.signal
    );
  }
}
