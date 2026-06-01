import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { z } from "zod";

import { AppError } from "../core/app-error.js";
import {
  buildPatchTargetNotFoundMessage,
  type PatchTargetHint
} from "./patch-target-hints.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  ArtifactDraft,
  SandboxFileAccessPlan,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const patchSchema = z.preprocess(
  normalizePatchAliases,
  z.object({
    find: z.string().min(1),
    afterContext: z.string().optional(),
    beforeContext: z.string().optional(),
    expectedOccurrences: z.number().int().positive().optional(),
    replace: z.string(),
    replaceAll: z.boolean().default(false)
  })
);

const fileWriteSchema = z
  .object({
    action: z.enum(["apply_patch", "apply_unified_diff", "delete_file", "rename_file", "update_file", "write_file"]),
    content: z.string().optional(),
    diff: z.string().optional(),
    dryRun: z.boolean().default(false),
    newText: z.string().optional(),
    overwrite: z.boolean().default(true),
    path: z.string().min(1),
    patches: z.array(patchSchema).optional(),
    replaceAll: z.boolean().default(false),
    targetText: z.string().optional(),
    toPath: z.string().min(1).optional()
  })
  .superRefine((value, context) => {
    if (value.action === "write_file" && value.content === undefined) {
      context.addIssue({
        code: "custom",
        message: "content is required for write_file."
      });
    }

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

type PreparedFileWriteInput =
  | {
      action: "write_file";
      content: string;
      dryRun: boolean;
      overwrite: boolean;
      plan: SandboxFileAccessPlan;
    }
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
      patches: Array<{
        afterContext?: string;
        beforeContext?: string;
        expectedOccurrences?: number;
        find: string;
        replace: string;
        replaceAll: boolean;
      }>;
      plan: SandboxFileAccessPlan;
    }
  | {
      action: "apply_unified_diff";
      dryRun: boolean;
      filePatches: UnifiedFilePatch[];
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

interface UnifiedFilePatch {
  hunks: UnifiedHunk[];
  newPath: string;
  oldPath: string;
}

interface UnifiedHunk {
  lines: string[];
  oldStart: number;
}

export class FileWriteTool implements ToolDefinition<typeof fileWriteSchema, PreparedFileWriteInput> {
  public readonly name = "file_write";
  public readonly description =
    "Create files, update file content, or apply simplified text patches inside the workspace.";
  public readonly capability = "filesystem.write" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "workspace_mutation" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = fileWriteSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      action: {
        enum: ["write_file", "update_file", "apply_patch", "apply_unified_diff", "delete_file", "rename_file"],
        type: "string"
      },
      content: {
        type: "string"
      },
      diff: {
        type: "string"
      },
      dryRun: {
        type: "boolean"
      },
      newText: {
        type: "string"
      },
      overwrite: {
        type: "boolean"
      },
      path: {
        type: "string"
      },
      patches: {
        description:
          "Only for apply_patch. Array of text replacements. Each item uses find/replace; oldText/newText and targetText/newText are accepted as aliases.",
        items: {
          properties: {
            afterContext: { type: "string" },
            beforeContext: { type: "string" },
            expectedOccurrences: { type: "number" },
            find: { type: "string" },
            newText: { description: "Alias for replace.", type: "string" },
            oldText: { description: "Alias for find.", type: "string" },
            replace: { type: "string" },
            replaceAll: { type: "boolean" },
            targetText: { description: "Alias for find.", type: "string" }
          },
          type: "object"
        },
        type: "array"
      },
      replaceAll: {
        type: "boolean"
      },
      targetText: {
        type: "string"
      },
      toPath: {
        type: "string"
      }
    },
    required: ["action", "path"],
    type: "object"
  };

  public constructor(private readonly sandboxService: SandboxService) {}

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedFileWriteInput> {
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareFileWrite(parsedInput.path, context.cwd);

    if (parsedInput.action === "write_file") {
      return {
        governance: {
          pathScope: plan.pathScope,
          summary: `Write file ${plan.resolvedPath}`
        },
        preparedInput: {
          action: parsedInput.action,
          content: parsedInput.content ?? "",
          dryRun: parsedInput.dryRun,
          overwrite: parsedInput.overwrite,
          plan
        },
        sandbox: plan
      };
    }

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
          pathScope: plan.pathScope === "workspace" && toPlan.pathScope === "workspace" ? "workspace" : toPlan.pathScope,
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
      const plans = filePatches.map((patch) =>
        this.sandboxService.prepareFileWrite(resolveUnifiedPatchPath(patch), context.cwd)
      );
      return {
        governance: {
          pathScope: plans.every((item) => item.pathScope === "workspace") ? "workspace" : (plans[0]?.pathScope ?? plan.pathScope),
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
            const preparedPatch: {
              afterContext?: string;
              beforeContext?: string;
              expectedOccurrences?: number;
              find: string;
              replace: string;
              replaceAll: boolean;
            } = {
              find: patch.find,
              replace: patch.replace,
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
    input: PreparedFileWriteInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (input.action === "write_file") {
      return this.writeFile(input, context);
    }

    if (input.action === "update_file") {
      return this.updateFile(input, context);
    }

    if (input.action === "delete_file") {
      return this.deleteFile(input, context);
    }

    if (input.action === "rename_file") {
      return this.renameFile(input, context);
    }

    if (input.action === "apply_unified_diff") {
      return this.applyUnifiedDiff(input, context);
    }

    return this.applyPatch(input, context);
  }

  private async writeFile(
    input: Extract<PreparedFileWriteInput, { action: "write_file" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    if (!input.overwrite) {
      const fileExists = await exists(targetPath);
      if (fileExists) {
        throw new AppError({
          code: "tool_execution_error",
          message: `File ${targetPath} already exists and overwrite=false.`
        });
      }
    }

    if (input.dryRun) {
      return fileWriteDryRunResult(targetPath, input.action, "", input.content);
    }

    const checkpoint = await createRollbackArtifact(targetPath, input.action, context.workspaceRoot);

    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, input.content, "utf8");

    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(input.content),
            beforeText: null,
            diffSummary: summarizeFileChange("", input.content),
            unifiedDiff: createUnifiedDiff("", input.content, targetPath),
            operation: "write_file",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        path: targetPath,
        size: Buffer.byteLength(input.content, "utf8")
      },
      success: true,
      summary: `Wrote ${targetPath}`
    };
  }

  private async updateFile(
    input: Extract<PreparedFileWriteInput, { action: "update_file" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");
    const occurrences = findOccurrences(originalContent, input.targetText);
    if (occurrences.length === 0) {
      const hint = buildPatchTargetNotFoundMessage(
        targetPath,
        input.targetText,
        originalContent,
        "Target text"
      );
      throw new AppError({
        code: "tool_execution_error",
        details: patchTargetHintDetails(hint.details),
        message: hint.message
      });
    }
    if (!input.replaceAll && occurrences.length > 1) {
      throw new AppError({
        code: "tool_execution_error",
        details: {
          occurrenceCount: occurrences.length
        },
        message: `Target text appears ${occurrences.length} times in ${targetPath}. Use replaceAll=true or provide a more specific targetText.`
      });
    }

    const firstOccurrence = occurrences[0];
    if (firstOccurrence === undefined) {
      const hint = buildPatchTargetNotFoundMessage(
        targetPath,
        input.targetText,
        originalContent,
        "Target text"
      );
      throw new AppError({
        code: "tool_execution_error",
        details: patchTargetHintDetails(hint.details),
        message: hint.message
      });
    }
    const updatedContent = replaceTextAtOccurrences(
      originalContent,
      input.targetText,
      input.newText,
      input.replaceAll ? occurrences : [firstOccurrence]
    );

    if (input.dryRun) {
      return fileWriteDryRunResult(targetPath, input.action, originalContent, updatedContent);
    }

    const checkpoint = await createRollbackArtifactFromContent(
      targetPath,
      input.action,
      originalContent,
      context.workspaceRoot
    );

    await fs.writeFile(targetPath, updatedContent, "utf8");

    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(updatedContent),
            beforeText: clipText(originalContent),
            diffSummary: summarizeFileChange(originalContent, updatedContent),
            unifiedDiff: createUnifiedDiff(originalContent, updatedContent, targetPath),
            operation: "update_file",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        path: targetPath,
        updated: true
      },
      success: true,
      summary: `Updated ${targetPath}`
    };
  }

  private async applyPatch(
    input: Extract<PreparedFileWriteInput, { action: "apply_patch" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");
    let workingContent = originalContent;
    let appliedPatchCount = 0;

    for (const patch of input.patches) {
      const candidates = findOccurrences(workingContent, patch.find);
      if (candidates.length === 0) {
        const hint = buildPatchTargetNotFoundMessage(targetPath, patch.find, workingContent);
        throw new AppError({
          code: "tool_execution_error",
          details: patchTargetHintDetails(hint.details),
          message: hint.message
        });
      }

      if (patch.expectedOccurrences !== undefined && patch.expectedOccurrences !== candidates.length) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            actualOccurrences: candidates.length,
            expectedOccurrences: patch.expectedOccurrences
          },
          message: `Patch target "${patch.find}" expected ${patch.expectedOccurrences} occurrences but found ${candidates.length} in ${targetPath}.`
        });
      }

      const scopedCandidates = candidates.filter((index) =>
        matchesPatchContext(workingContent, index, patch.find, patch.beforeContext, patch.afterContext)
      );
      if (scopedCandidates.length === 0) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            candidateCount: candidates.length
          },
          message: `Patch target "${patch.find}" was found ${candidates.length} times, but none matched provided context in ${targetPath}.`
        });
      }
      if (!patch.replaceAll && scopedCandidates.length > 1) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            candidateCount: scopedCandidates.length
          },
          message: `Patch target "${patch.find}" matched ${scopedCandidates.length} locations in ${targetPath}. Use replaceAll=true or add beforeContext/afterContext.`
        });
      }

      const firstScopedOccurrence = scopedCandidates[0];
      if (firstScopedOccurrence === undefined) {
        throw new AppError({
          code: "tool_execution_error",
          message: `Patch target "${patch.find}" did not resolve to a valid location in ${targetPath}.`
        });
      }
      workingContent = replaceTextAtOccurrences(
        workingContent,
        patch.find,
        patch.replace,
        patch.replaceAll ? scopedCandidates : [firstScopedOccurrence]
      );
      appliedPatchCount += 1;
    }

    if (context.signal.aborted) {
      throw new AppError({
        code: "interrupt",
        message: "File patch interrupted."
      });
    }

    if (input.dryRun) {
      return fileWriteDryRunResult(targetPath, input.action, originalContent, workingContent);
    }

    const checkpoint = await createRollbackArtifactFromContent(
      targetPath,
      input.action,
      originalContent,
      context.workspaceRoot
    );

    await fs.writeFile(targetPath, workingContent, "utf8");

    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(workingContent),
            beforeText: clipText(originalContent),
            diffSummary: summarizeFileChange(originalContent, workingContent),
            unifiedDiff: createUnifiedDiff(originalContent, workingContent, targetPath),
            operation: "apply_patch",
            path: targetPath
          },
          uri: targetPath
        }
      ],
      output: {
        appliedPatchCount,
        path: targetPath
      },
      success: true,
      summary: `Applied ${appliedPatchCount} patches to ${targetPath}`
    };
  }

  private async deleteFile(
    input: Extract<PreparedFileWriteInput, { action: "delete_file" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const targetPath = input.plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");

    if (input.dryRun) {
      return fileWriteDryRunResult(targetPath, input.action, originalContent, "");
    }

    const checkpoint = await createRollbackArtifactFromContent(
      targetPath,
      input.action,
      originalContent,
      context.workspaceRoot
    );

    await fs.unlink(targetPath);
    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: null,
            beforeText: clipText(originalContent),
            diffSummary: summarizeFileChange(originalContent, ""),
            operation: "delete_file",
            path: targetPath,
            unifiedDiff: createUnifiedDiff(originalContent, "", targetPath)
          },
          uri: targetPath
        }
      ],
      output: {
        deleted: true,
        path: targetPath
      },
      success: true,
      summary: `Deleted ${targetPath}`
    };
  }

  private async renameFile(
    input: Extract<PreparedFileWriteInput, { action: "rename_file" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const fromPath = input.fromPlan.resolvedPath;
    const toPath = input.toPlan.resolvedPath;
    const originalContent = await fs.readFile(fromPath, "utf8");
    if (!input.overwrite && await exists(toPath)) {
      throw new AppError({
        code: "tool_execution_error",
        message: `File ${toPath} already exists and overwrite=false.`
      });
    }

    if (input.dryRun) {
      return {
        artifacts: [
          {
            artifactType: "file",
            content: {
              afterText: clipText(originalContent),
              beforeText: clipText(originalContent),
              diffSummary: summarizeFileChange(originalContent, originalContent),
              dryRun: true,
              operation: "rename_file",
              path: fromPath,
              toPath,
              unifiedDiff: ""
            },
            uri: fromPath
          }
        ],
        output: {
          dryRun: true,
          path: fromPath,
          toPath
        },
        success: true,
        summary: `Dry run: would rename ${fromPath} to ${toPath}`
      };
    }

    const checkpoint = await createRollbackArtifactFromContent(
      fromPath,
      input.action,
      originalContent,
      context.workspaceRoot
    );

    await fs.mkdir(dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
    return {
      artifacts: [
        checkpoint,
        {
          artifactType: "file",
          content: {
            afterText: clipText(originalContent),
            beforeText: clipText(originalContent),
            diffSummary: summarizeFileChange(originalContent, originalContent),
            operation: "rename_file",
            path: fromPath,
            toPath,
            unifiedDiff: ""
          },
          uri: toPath
        }
      ],
      output: {
        path: fromPath,
        renamed: true,
        toPath
      },
      success: true,
      summary: `Renamed ${fromPath} to ${toPath}`
    };
  }

  private async applyUnifiedDiff(
    input: Extract<PreparedFileWriteInput, { action: "apply_unified_diff" }>,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const fileArtifacts: ArtifactDraft[] = [];
    const rollbackArtifacts: ArtifactDraft[] = [];
    const outputs: Array<{ path: string; updated: boolean }> = [];

    for (const [index, filePatch] of input.filePatches.entries()) {
      const plan = input.plans[index];
      if (plan === undefined) {
        throw new AppError({
          code: "tool_execution_error",
          message: "Unified diff patch did not resolve to a sandbox plan."
        });
      }
      const targetPath = plan.resolvedPath;
      const originalContent = await fs.readFile(targetPath, "utf8");
      const updatedContent = applyUnifiedPatch(originalContent, filePatch, targetPath);
      if (!input.dryRun) {
        rollbackArtifacts.push(
          await createRollbackArtifactFromContent(
            targetPath,
            input.action,
            originalContent,
            context.workspaceRoot
          )
        );
        await fs.writeFile(targetPath, updatedContent, "utf8");
      }
      fileArtifacts.push({
        artifactType: "file",
        content: {
          afterText: clipText(updatedContent),
          beforeText: clipText(originalContent),
          diffSummary: summarizeFileChange(originalContent, updatedContent),
          dryRun: input.dryRun,
          operation: "apply_unified_diff",
          path: targetPath,
          unifiedDiff: createUnifiedDiff(originalContent, updatedContent, targetPath)
        },
        uri: targetPath
      });
      outputs.push({
        path: targetPath,
        updated: true
      });
    }

    return {
      artifacts: [...rollbackArtifacts, ...fileArtifacts],
      output: {
        dryRun: input.dryRun,
        files: outputs
      },
      success: true,
      summary: `${input.dryRun ? "Dry run: would apply" : "Applied"} unified diff to ${outputs.length} files`
    };
  }
}

async function createRollbackArtifact(
  targetPath: string,
  operation: FileWriteOperation,
  workspaceRoot: string
): Promise<ArtifactDraft> {
  try {
    const originalContent = await fs.readFile(targetPath, "utf8");
    return createRollbackArtifactFromContent(targetPath, operation, originalContent, workspaceRoot);
  } catch {
    return {
      artifactType: "file_rollback",
      content: {
        createdAt: new Date().toISOString(),
        originalContent: null,
        originalExists: false,
        operation,
        path: targetPath,
        sha256: null
      },
      uri: `rollback:${targetPath}`
    };
  }
}

async function createRollbackArtifactFromContent(
  targetPath: string,
  operation: FileWriteOperation,
  originalContent: string,
  workspaceRoot: string
): Promise<ArtifactDraft> {
  const snapshotPath = await writeRollbackSnapshot(workspaceRoot, targetPath, originalContent);
  return {
    artifactType: "file_rollback",
    content: {
      createdAt: new Date().toISOString(),
      originalContent,
      originalExists: true,
      operation,
      path: targetPath,
      snapshotPath,
      sha256: createHash("sha256").update(originalContent, "utf8").digest("hex")
    },
    uri: `rollback:${targetPath}`
  };
}

type FileWriteOperation = PreparedFileWriteInput["action"];

function fileWriteDryRunResult(
  targetPath: string,
  operation: FileWriteOperation,
  originalContent: string,
  updatedContent: string
): ToolExecutionResult {
  return {
    artifacts: [
      {
        artifactType: "file",
        content: {
          afterText: clipText(updatedContent),
          beforeText: clipText(originalContent),
          diffSummary: summarizeFileChange(originalContent, updatedContent),
          dryRun: true,
          operation,
          path: targetPath,
          unifiedDiff: createUnifiedDiff(originalContent, updatedContent, targetPath)
        },
        uri: targetPath
      }
    ],
    output: {
      dryRun: true,
      path: targetPath
    },
    success: true,
    summary: `Dry run: would ${operation} ${targetPath}`
  };
}

async function writeRollbackSnapshot(
  workspaceRoot: string,
  targetPath: string,
  originalContent: string
): Promise<string> {
  const hash = createHash("sha256").update(targetPath).digest("hex").slice(0, 12);
  const rollbackDir = join(workspaceRoot, ".auto-talon", "rollbacks");
  await fs.mkdir(rollbackDir, { recursive: true });
  const snapshotPath = join(rollbackDir, `${Date.now()}-${hash}.snapshot`);
  await fs.writeFile(snapshotPath, originalContent, "utf8");
  return snapshotPath;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function findOccurrences(content: string, target: string): number[] {
  const occurrences: number[] = [];
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(target, offset);
    if (index === -1) {
      break;
    }
    occurrences.push(index);
    offset = index + target.length;
  }
  return occurrences;
}

function replaceTextAtOccurrences(
  content: string,
  find: string,
  replace: string,
  occurrences: number[]
): string {
  let cursor = 0;
  const parts: string[] = [];
  const sorted = [...occurrences].sort((left, right) => left - right);
  for (const index of sorted) {
    parts.push(content.slice(cursor, index), replace);
    cursor = index + find.length;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

function matchesPatchContext(
  content: string,
  index: number,
  find: string,
  beforeContext: string | undefined,
  afterContext: string | undefined
): boolean {
  if (beforeContext !== undefined) {
    const beforeStart = index - beforeContext.length;
    if (beforeStart < 0 || content.slice(beforeStart, index) !== beforeContext) {
      return false;
    }
  }

  if (afterContext !== undefined) {
    const afterStart = index + find.length;
    const afterEnd = afterStart + afterContext.length;
    if (content.slice(afterStart, afterEnd) !== afterContext) {
      return false;
    }
  }

  return true;
}

function parseUnifiedDiff(diff: string): UnifiedFilePatch[] {
  const lines = diff.split(/\r?\n/u);
  const patches: UnifiedFilePatch[] = [];
  let current: UnifiedFilePatch | null = null;
  let currentHunk: UnifiedHunk | null = null;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (current !== null) {
        patches.push(current);
      }
      current = {
        hunks: [],
        newPath: "",
        oldPath: normalizeDiffPath(line.slice(4).trim())
      };
      currentHunk = null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (current === null) {
        throw new AppError({
          code: "tool_validation_error",
          message: "Unified diff has +++ before ---."
        });
      }
      current.newPath = normalizeDiffPath(line.slice(4).trim());
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (current === null) {
        throw new AppError({
          code: "tool_validation_error",
          message: "Unified diff hunk appears before file header."
        });
      }
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/u.exec(line);
      if (match === null) {
        throw new AppError({
          code: "tool_validation_error",
          message: `Unsupported unified diff hunk header: ${line}`
        });
      }
      currentHunk = {
        lines: [],
        oldStart: Number(match[1])
      };
      current.hunks.push(currentHunk);
      continue;
    }
    if (currentHunk !== null && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) {
      currentHunk.lines.push(line);
    }
  }

  if (current !== null) {
    patches.push(current);
  }
  if (patches.length === 0 || patches.some((patch) => patch.newPath.length === 0 || patch.hunks.length === 0)) {
    throw new AppError({
      code: "tool_validation_error",
      message: "Unified diff must include file headers and at least one hunk."
    });
  }
  return patches;
}

function normalizeDiffPath(path: string): string {
  if (path === "/dev/null") {
    return path;
  }
  return path.replace(/^[ab]\//u, "");
}

function resolveUnifiedPatchPath(patch: UnifiedFilePatch): string {
  return patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
}

function applyUnifiedPatch(
  originalContent: string,
  patch: UnifiedFilePatch,
  targetPath: string
): string {
  const originalLines = originalContent.split(/\r?\n/u);
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of patch.hunks) {
    const hunkStart = Math.max(hunk.oldStart - 1, 0);
    output.push(...originalLines.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        continue;
      }
      const prefix = line[0];
      const value = line.slice(1);
      if (prefix === " ") {
        assertUnifiedLine(originalLines[cursor], value, targetPath);
        output.push(value);
        cursor += 1;
        continue;
      }
      if (prefix === "-") {
        assertUnifiedLine(originalLines[cursor], value, targetPath);
        cursor += 1;
        continue;
      }
      if (prefix === "+") {
        output.push(value);
      }
    }
  }

  output.push(...originalLines.slice(cursor));
  return output.join("\n");
}

function assertUnifiedLine(actual: string | undefined, expected: string, targetPath: string): void {
  if ((actual ?? "") !== expected) {
    throw new AppError({
      code: "tool_execution_error",
      details: {
        actual,
        expected
      },
      message: `Unified diff context did not match ${targetPath}. Re-read the file and regenerate the patch.`
    });
  }
}

function patchTargetHintDetails(hint: PatchTargetHint): Record<string, unknown> {
  return {
    fileHead: hint.fileHead,
    nearestLine: hint.nearestLine,
    nearestMatch: hint.nearestMatch,
    similarityPercent: hint.similarityPercent
  };
}

function normalizePatchAliases(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  return {
    ...record,
    find: record.find ?? record.oldText ?? record.targetText,
    replace: record.replace ?? record.newText
  };
}

function summarizeFileChange(beforeText: string, afterText: string): {
  addedLineCount: number;
  afterLineCount: number;
  beforeLineCount: number;
  changedLineCount: number;
  removedLineCount: number;
} {
  const beforeLines = beforeText.split(/\r?\n/);
  const afterLines = afterText.split(/\r?\n/);
  const maxLineCount = Math.max(beforeLines.length, afterLines.length);
  let changedLineCount = 0;

  for (let index = 0; index < maxLineCount; index += 1) {
    if ((beforeLines[index] ?? "") !== (afterLines[index] ?? "")) {
      changedLineCount += 1;
    }
  }

  return {
    addedLineCount: Math.max(afterLines.length - beforeLines.length, 0),
    afterLineCount: afterLines.length,
    beforeLineCount: beforeLines.length,
    changedLineCount,
    removedLineCount: Math.max(beforeLines.length - afterLines.length, 0)
  };
}

function clipText(value: string, maxLength = 4_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}

function createUnifiedDiff(beforeText: string, afterText: string, path: string): string {
  const beforeLines = beforeText.split(/\r?\n/u);
  const afterLines = afterText.split(/\r?\n/u);
  const maxLineCount = Math.max(beforeLines.length, afterLines.length);
  const lines = [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@"];

  for (let index = 0; index < maxLineCount; index += 1) {
    const beforeLine = beforeLines[index];
    const afterLine = afterLines[index];
    if (beforeLine === afterLine) {
      if (beforeLine !== undefined) {
        lines.push(` ${beforeLine}`);
      }
      continue;
    }
    if (beforeLine !== undefined) {
      lines.push(`-${beforeLine}`);
    }
    if (afterLine !== undefined) {
      lines.push(`+${afterLine}`);
    }
  }

  return clipText(lines.join("\n"), 12_000);
}
