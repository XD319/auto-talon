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

const patchSchema = z
  .object({
    action: z.enum(["apply_patch", "apply_unified_diff", "delete_file", "rename_file", "update_file"]),
    diff: z.string().optional(),
    dryRun: z.boolean().default(false),
    newText: z.string().optional(),
    overwrite: z.boolean().default(true),
    path: z.string().min(1),
    patches: z.array(patchEntrySchema).optional(),
    replaceAll: z.boolean().default(false),
    targetText: z.string().optional(),
    toPath: z.string().min(1).optional()
  })
  .superRefine((value, context) => {
    if (value.action === "update_file") {
      if (value.targetText === undefined || value.newText === undefined) {
        context.addIssue({
          code: "custom",
          message: "targetText and newText are required for update_file."
        });
      }
    }

    if (value.action === "apply_patch" && value.patches === undefined) {
      context.addIssue({
        code: "custom",
        message: "patches are required for apply_patch."
      });
    }

    if (value.action === "apply_unified_diff" && value.diff === undefined) {
      context.addIssue({
        code: "custom",
        message: "diff is required for apply_unified_diff."
      });
    }

    if (value.action === "rename_file" && value.toPath === undefined) {
      context.addIssue({
        code: "custom",
        message: "toPath is required for rename_file."
      });
    }
  });

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
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = patchSchema;

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedPatchInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);

    if (parsedInput.action === "update_file") {
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Update file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          dryRun: parsedInput.dryRun,
          newText: parsedInput.newText ?? "",
          plan,
          replaceAll: parsedInput.replaceAll,
          targetText: parsedInput.targetText ?? ""
        },
        sandbox: plan
      };
    }

    if (parsedInput.action === "delete_file") {
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
      const toPlan = this.sandboxService.prepareFileWrite(parsedInput.toPath ?? "", context.cwd);
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
      const filePatches = parseUnifiedDiff(parsedInput.diff ?? "");
      const plans = filePatches.map((filePatch) =>
        this.sandboxService.prepareFileWrite(resolveUnifiedPatchPath(filePatch), context.cwd)
      );
      return {
        governance: {
          pathScope: plans.every((item) => item.pathScope === "workspace")
            ? "workspace"
            : (plans[0]?.pathScope ?? plan.pathScope),
          summary: `Apply unified diff to ${plans.length} files`
        },
        preparedInput: {
          action: parsedInput.action,
          dryRun: parsedInput.dryRun,
          filePatches,
          plans
        },
        sandbox: plans[0] ?? plan
      };
    }

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Apply patch to ${plan.resolvedPath}`
      },
      preparedInput: {
        action: parsedInput.action,
        dryRun: parsedInput.dryRun,
        patches:
          parsedInput.patches?.map((patch) => {
            const normalized = normalizePatchAliases(patch) as Record<string, unknown>;
            const preparedPatch: PreparedPatchEntry = {
              find: String(normalized.find ?? ""),
              replace: String(normalized.replace ?? ""),
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
          }) ?? [],
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
