import { z } from "zod";

import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

import {
  executeApplyPatch,
  executeApplyUnifiedDiff,
  executeDeleteFile,
  executeRenameFile,
  executeUpdateFile,
  normalizePatchAliases,
  parseUnifiedDiff,
  resolveUnifiedPatchPath,
  type PreparedPatchEntry
} from "./file/executors.js";

const patchEntrySchema = z
  .object({
    find: z.string().min(1).optional(),
    oldText: z.string().min(1).optional(),
    targetText: z.string().min(1).optional(),
    replace: z.string().optional(),
    newText: z.string().optional(),
    afterContext: z.string().optional(),
    beforeContext: z.string().optional(),
    expectedOccurrences: z.number().int().positive().optional(),
    replaceAll: z.boolean().default(false)
  })
  .superRefine((value, context) => {
    const find = value.find ?? value.oldText ?? value.targetText;
    if (find === undefined || find.length === 0) {
      context.addIssue({
        code: "custom",
        message: "find, oldText, or targetText is required for each patch entry."
      });
    }
    if ((value.replace ?? value.newText) === undefined) {
      context.addIssue({
        code: "custom",
        message: "replace or newText is required for each patch entry."
      });
    }
  });

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update_file"),
    dryRun: z.boolean().default(false),
    newText: z.string(),
    path: z.string().min(1),
    replaceAll: z.boolean().default(false),
    targetText: z.string().min(1)
  }),
  z.object({
    action: z.literal("apply_patch"),
    dryRun: z.boolean().default(false),
    patches: z.array(patchEntrySchema).min(1),
    path: z.string().min(1)
  }),
  z.object({
    action: z.literal("apply_unified_diff"),
    diff: z.string().min(1),
    dryRun: z.boolean().default(false),
    // Paths come from the diff headers; this is only a fallback scope anchor.
    path: z.string().min(1).optional()
  }),
  z.object({
    action: z.literal("delete_file"),
    dryRun: z.boolean().default(false),
    path: z.string().min(1)
  }),
  z.object({
    action: z.literal("rename_file"),
    dryRun: z.boolean().default(false),
    overwrite: z.boolean().default(true),
    path: z.string().min(1),
    toPath: z.string().min(1)
  })
]);

type PreparedPatchInput =
  | {
      action: "update_file";
      dryRun: boolean;
      newText: string;
      plan: SandboxFileAccessPlan;
      replaceAll: boolean;
      targetText: string;
    }
  | {
      action: "apply_patch";
      dryRun: boolean;
      patches: PreparedPatchEntry[];
      plan: SandboxFileAccessPlan;
    }
  | {
      action: "apply_unified_diff";
      dryRun: boolean;
      filePatches: ReturnType<typeof parseUnifiedDiff>;
      plans: SandboxFileAccessPlan[];
    }
  | {
      action: "delete_file";
      dryRun: boolean;
      plan: SandboxFileAccessPlan;
    }
  | {
      action: "rename_file";
      dryRun: boolean;
      fromPlan: SandboxFileAccessPlan;
      overwrite: boolean;
      toPlan: SandboxFileAccessPlan;
    };

export class PatchTool implements ToolDefinition<typeof patchSchema, PreparedPatchInput> {
  public readonly name = "patch";
  public readonly description =
    "Update, patch, delete, rename files, or apply unified diffs inside the workspace.";
  public readonly capability = "filesystem.write" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = patchSchema;

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedPatchInput> {
    const parsedInput = this.inputSchema.parse(input);

    if (parsedInput.action === "update_file") {
      const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Update file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          dryRun: parsedInput.dryRun,
          newText: parsedInput.newText,
          plan,
          replaceAll: parsedInput.replaceAll,
          targetText: parsedInput.targetText
        },
        sandbox: plan
      };
    }

    if (parsedInput.action === "delete_file") {
      const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Delete file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          dryRun: parsedInput.dryRun,
          plan
        },
        sandbox: plan
      };
    }

    if (parsedInput.action === "rename_file") {
      const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);
      const toPlan = this.sandboxService.prepareFileWrite(parsedInput.toPath, context.cwd);
      return {
        governance: {
          pathScope:
            plan.pathScope === "workspace" && toPlan.pathScope === "workspace"
              ? "workspace"
              : toPlan.pathScope,
          summary: `Rename file ${plan.resolvedPath} to ${toPlan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          dryRun: parsedInput.dryRun,
          fromPlan: plan,
          overwrite: parsedInput.overwrite,
          toPlan
        },
        sandbox: toPlan
      };
    }

    if (parsedInput.action === "apply_unified_diff") {
      const filePatches = parseUnifiedDiff(parsedInput.diff);
      const plans = filePatches.map((filePatch) =>
        this.sandboxService.prepareFileWrite(resolveUnifiedPatchPath(filePatch), context.cwd)
      );
      const fallbackPlan = this.sandboxService.prepareFileWrite(
        parsedInput.path ?? ".",
        context.cwd
      );
      return {
        governance: {
          pathScope: plans.every((item) => item.pathScope === "workspace")
            ? "workspace"
            : (plans[0]?.pathScope ?? fallbackPlan.pathScope),
          summary: `Apply unified diff to ${plans.length} files`
        },
        preparedInput: {
          action: parsedInput.action,
          dryRun: parsedInput.dryRun,
          filePatches,
          plans
        },
        sandbox: plans[0] ?? fallbackPlan
      };
    }

    const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);
    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Apply patch to ${plan.resolvedPath}`
      },
      preparedInput: {
        action: parsedInput.action,
        dryRun: parsedInput.dryRun,
        patches: parsedInput.patches.map((patch) => {
          const normalized = normalizePatchAliases(patch) as Record<string, unknown>;
          const find = normalized.find;
          const replace = normalized.replace;
          const preparedPatch: PreparedPatchEntry = {
            find: typeof find === "string" ? find : "",
            replace: typeof replace === "string" ? replace : "",
            replaceAll: patch.replaceAll
          };
          if (patch.afterContext !== undefined) {
            preparedPatch.afterContext = patch.afterContext;
          }
          if (patch.beforeContext !== undefined) {
            preparedPatch.beforeContext = patch.beforeContext;
          }
          if (patch.expectedOccurrences !== undefined) {
            preparedPatch.expectedOccurrences = patch.expectedOccurrences;
          }
          return preparedPatch;
        }),
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedPatchInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (input.action === "update_file") {
      return executeUpdateFile(
        input.plan,
        input.targetText,
        input.newText,
        input.replaceAll,
        input.dryRun,
        context
      );
    }

    if (input.action === "delete_file") {
      return executeDeleteFile(input.plan, input.dryRun, context);
    }

    if (input.action === "rename_file") {
      return executeRenameFile(input.fromPlan, input.toPlan, input.overwrite, input.dryRun, context);
    }

    if (input.action === "apply_unified_diff") {
      return executeApplyUnifiedDiff(input.filePatches, input.plans, input.dryRun, context);
    }

    return executeApplyPatch(input.plan, input.patches, input.dryRun, context);
  }
}
