import { z } from "zod";

import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import { executeWriteFile } from "./file/executors.js";

const writeFileSchema = z.object({
  content: z.string(),
  dryRun: z.boolean().default(false),
  overwrite: z.boolean().default(true),
  path: z.string().min(1)
});

export interface PreparedWriteFileInput {
  content: string;
  dryRun: boolean;
  overwrite: boolean;
  plan: SandboxFileAccessPlan;
}

export class WriteFileTool implements ToolDefinition<typeof writeFileSchema, PreparedWriteFileInput> {
  public readonly name = "write_file";
  public readonly description = "Create or overwrite a file inside the workspace.";
  public readonly capability = "filesystem.write" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = writeFileSchema;

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedWriteFileInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Write file ${plan.resolvedPath}`
      },
      preparedInput: {
        content: parsedInput.content,
        dryRun: parsedInput.dryRun,
        overwrite: parsedInput.overwrite,
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedWriteFileInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    return executeWriteFile(input.plan, input.content, input.overwrite, input.dryRun, context);
  }
}
