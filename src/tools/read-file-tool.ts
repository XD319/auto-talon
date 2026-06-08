import { z } from "zod";

import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import { executeReadFile } from "./file/executors.js";

const readFileSchema = z.object({
  limit: z.number().int().positive().max(20_000).default(5_000),
  offset: z.number().int().min(0).default(0),
  path: z.string().min(1)
});

export interface PreparedReadFileInput {
  limit: number;
  offset: number;
  plan: SandboxFileAccessPlan;
}

export class ReadFileTool implements ToolDefinition<typeof readFileSchema, PreparedReadFileInput> {
  public readonly name = "read_file";
  public readonly description = "Read a file from the workspace with optional offset and line limit.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = readFileSchema;

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedReadFileInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileRead(parsedInput.path, context.cwd);

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Read file ${plan.resolvedPath}`
      },
      preparedInput: {
        limit: parsedInput.limit,
        offset: parsedInput.offset,
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedReadFileInput,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    return executeReadFile(input.plan, input.offset, input.limit);
  }
}
