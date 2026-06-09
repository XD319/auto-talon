import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join, relative, sep } from "node:path";

import { AppError } from "../../core/app-error.js";
import {
  aggregateFileDiffSummaries,
  buildFileChangeOutput,
  formatDiffLineBadge,
  formatFileEditSummary
} from "../../presentation/file-change-summary.js";
import {
  buildPatchTargetNotFoundMessage,
  type PatchTargetHint
} from "../patch-target-hints.js";
import type { ArtifactDraft, SandboxFileAccessPlan, ToolExecutionContext, ToolExecutionResult } from "../../types/index.js";

export type FileWriteOperation =
  | "apply_patch"
  | "apply_unified_diff"
  | "delete_file"
  | "rename_file"
  | "update_file"
  | "write_file";

export interface PreparedPatchEntry {
  afterContext?: string;
  beforeContext?: string;
  expectedOccurrences?: number;
  find: string;
  replace: string;
  replaceAll: boolean;
}

export interface UnifiedFilePatch {
  hunks: UnifiedHunk[];
  newPath: string;
  oldPath: string;
}

export interface UnifiedHunk {
  lines: string[];
  oldStart: number;
}

export async function executeReadFile(
  plan: SandboxFileAccessPlan,
  offset: number,
  limit: number
): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  const stat = await fs.stat(targetPath);
  if (stat.isDirectory()) {
    return {
      details: {
        path: targetPath,
        suggestedTool: "glob"
      },
      errorCode: "tool_validation_error",
      errorMessage: `${targetPath} is a directory. Use glob to inspect directories.`,
      success: false
    };
  }

  const content = await fs.readFile(targetPath, "utf8");
  const lines = content.split(/\r?\n/u);
  const start = Math.min(offset, lines.length);
  const end = Math.min(start + limit, lines.length);
  const sliced = lines.slice(start, end).join("\n");

  return {
    output: {
      content: sliced,
      endLine: end,
      lineCount: lines.length,
      offset,
      path: targetPath
    },
    success: true,
    summary: `Read ${basename(targetPath)} lines ${start + 1}-${end}`
  };
}

export async function executeListDirectory(plan: SandboxFileAccessPlan): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  return {
    output: {
      entries: entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file"
      })),
      path: targetPath
    },
    success: true,
    summary: `Listed ${entries.length} entries from ${basename(targetPath)}`
  };
}

export async function executeGlob(
  plan: SandboxFileAccessPlan,
  pattern: string | null,
  recursive: boolean,
  maxResults: number,
  signal: AbortSignal
): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  const stat = await fs.stat(targetPath);

  if (pattern === null) {
    if (!stat.isDirectory()) {
      return {
        output: {
          entries: [{ name: basename(targetPath), path: targetPath, type: "file" }],
          path: targetPath
        },
        success: true,
        summary: `Listed 1 entry from ${basename(targetPath)}`
      };
    }
    return executeListDirectory(plan);
  }

  const matches: Array<{ name: string; path: string; type: "directory" | "file" }> = [];
  if (stat.isDirectory()) {
    await walkGlobMatches(targetPath, targetPath, pattern, recursive, maxResults, matches, signal);
  } else {
    const relativePath = basename(targetPath);
    if (globToRegExp(pattern).test(normalizePath(relativePath))) {
      matches.push({ name: basename(targetPath), path: targetPath, type: "file" });
    }
  }

  return {
    output: {
      matches,
      path: targetPath,
      pattern,
      truncated: matches.length >= maxResults
    },
    success: true,
    summary: `Found ${matches.length} matches for "${pattern}" under ${basename(targetPath)}`
  };
}

export async function executeWriteFile(
  plan: SandboxFileAccessPlan,
  content: string,
  overwrite: boolean,
  dryRun: boolean,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  if (!overwrite) {
    const fileExists = await exists(targetPath);
    if (fileExists) {
      throw new AppError({
        code: "tool_execution_error",
        message: `File ${targetPath} already exists and overwrite=false.`
      });
    }
  }

  if (dryRun) {
    return fileWriteDryRunResult(targetPath, "write_file", "", content);
  }

  const checkpoint = await createRollbackArtifact(targetPath, "write_file", context.workspaceRoot);

  await fs.mkdir(dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content, "utf8");

  const diffSummary = summarizeFileChange("", content);
  return {
    artifacts: [
      checkpoint,
      {
        artifactType: "file",
        content: {
          afterText: clipText(content),
          beforeText: null,
          diffSummary,
          unifiedDiff: createUnifiedDiff("", content, targetPath),
          operation: "write_file",
          path: targetPath
        },
        uri: targetPath
      }
    ],
    output: buildFileChangeOutput(targetPath, diffSummary, {
      size: Buffer.byteLength(content, "utf8")
    }),
    success: true,
    summary: formatFileEditSummary("Wrote", targetPath, diffSummary)
  };
}

export async function executeUpdateFile(
  plan: SandboxFileAccessPlan,
  targetText: string,
  newText: string,
  replaceAll: boolean,
  dryRun: boolean,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  const originalContent = await fs.readFile(targetPath, "utf8");
  const occurrences = findOccurrences(originalContent, targetText);
  if (occurrences.length === 0) {
    const hint = buildPatchTargetNotFoundMessage(
      targetPath,
      targetText,
      originalContent,
      "Target text"
    );
    throw new AppError({
      code: "tool_execution_error",
      details: patchTargetHintDetails(hint.details),
      message: hint.message
    });
  }
  if (!replaceAll && occurrences.length > 1) {
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
      targetText,
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
    targetText,
    newText,
    replaceAll ? occurrences : [firstOccurrence]
  );

  if (dryRun) {
    return fileWriteDryRunResult(targetPath, "update_file", originalContent, updatedContent);
  }

  const checkpoint = await createRollbackArtifactFromContent(
    targetPath,
    "update_file",
    originalContent,
    context.workspaceRoot
  );

  await fs.writeFile(targetPath, updatedContent, "utf8");

  const diffSummary = summarizeFileChange(originalContent, updatedContent);
  return {
    artifacts: [
      checkpoint,
      {
        artifactType: "file",
        content: {
          afterText: clipText(updatedContent),
          beforeText: clipText(originalContent),
          diffSummary,
          unifiedDiff: createUnifiedDiff(originalContent, updatedContent, targetPath),
          operation: "update_file",
          path: targetPath
        },
        uri: targetPath
      }
    ],
    output: buildFileChangeOutput(targetPath, diffSummary, { updated: true }),
    success: true,
    summary: formatFileEditSummary("Updated", targetPath, diffSummary)
  };
}

export async function executeApplyPatch(
  plan: SandboxFileAccessPlan,
  patches: PreparedPatchEntry[],
  dryRun: boolean,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  const originalContent = await fs.readFile(targetPath, "utf8");
  let workingContent = originalContent;
  let appliedPatchCount = 0;

  for (const patch of patches) {
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

  if (dryRun) {
    return fileWriteDryRunResult(targetPath, "apply_patch", originalContent, workingContent);
  }

  const checkpoint = await createRollbackArtifactFromContent(
    targetPath,
    "apply_patch",
    originalContent,
    context.workspaceRoot
  );

  await fs.writeFile(targetPath, workingContent, "utf8");

  const diffSummary = summarizeFileChange(originalContent, workingContent);
  return {
    artifacts: [
      checkpoint,
      {
        artifactType: "file",
        content: {
          afterText: clipText(workingContent),
          beforeText: clipText(originalContent),
          diffSummary,
          unifiedDiff: createUnifiedDiff(originalContent, workingContent, targetPath),
          operation: "apply_patch",
          path: targetPath
        },
        uri: targetPath
      }
    ],
    output: buildFileChangeOutput(targetPath, diffSummary, { appliedPatchCount }),
    success: true,
    summary: formatFileEditSummary(`Applied ${appliedPatchCount} patches to`, targetPath, diffSummary)
  };
}

export async function executeDeleteFile(
  plan: SandboxFileAccessPlan,
  dryRun: boolean,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const targetPath = plan.resolvedPath;
  const originalContent = await fs.readFile(targetPath, "utf8");

  if (dryRun) {
    return fileWriteDryRunResult(targetPath, "delete_file", originalContent, "");
  }

  const checkpoint = await createRollbackArtifactFromContent(
    targetPath,
    "delete_file",
    originalContent,
    context.workspaceRoot
  );

  await fs.unlink(targetPath);
  const diffSummary = summarizeFileChange(originalContent, "");
  return {
    artifacts: [
      checkpoint,
      {
        artifactType: "file",
        content: {
          afterText: null,
          beforeText: clipText(originalContent),
          diffSummary,
          operation: "delete_file",
          path: targetPath,
          unifiedDiff: createUnifiedDiff(originalContent, "", targetPath)
        },
        uri: targetPath
      }
    ],
    output: buildFileChangeOutput(targetPath, diffSummary, { deleted: true }),
    success: true,
    summary: formatFileEditSummary("Deleted", targetPath, diffSummary)
  };
}

export async function executeRenameFile(
  fromPlan: SandboxFileAccessPlan,
  toPlan: SandboxFileAccessPlan,
  overwrite: boolean,
  dryRun: boolean,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const fromPath = fromPlan.resolvedPath;
  const toPath = toPlan.resolvedPath;
  const originalContent = await fs.readFile(fromPath, "utf8");
  if (!overwrite && (await exists(toPath))) {
    throw new AppError({
      code: "tool_execution_error",
      message: `File ${toPath} already exists and overwrite=false.`
    });
  }

  if (dryRun) {
    const diffSummary = summarizeFileChange(originalContent, originalContent);
    return {
      artifacts: [
        {
          artifactType: "file",
          content: {
            afterText: clipText(originalContent),
            beforeText: clipText(originalContent),
            diffSummary,
            dryRun: true,
            operation: "rename_file",
            path: fromPath,
            toPath,
            unifiedDiff: ""
          },
          uri: fromPath
        }
      ],
      output: buildFileChangeOutput(fromPath, diffSummary, { dryRun: true, toPath }),
      success: true,
      summary: `${formatFileEditSummary("Dry run: would rename", fromPath, diffSummary)} to ${toPath}`
    };
  }

  const checkpoint = await createRollbackArtifactFromContent(
    fromPath,
    "rename_file",
    originalContent,
    context.workspaceRoot
  );

  await fs.mkdir(dirname(toPath), { recursive: true });
  await fs.rename(fromPath, toPath);
  const diffSummary = summarizeFileChange(originalContent, originalContent);
  return {
    artifacts: [
      checkpoint,
      {
        artifactType: "file",
        content: {
          afterText: clipText(originalContent),
          beforeText: clipText(originalContent),
          diffSummary,
          operation: "rename_file",
          path: fromPath,
          toPath,
          unifiedDiff: ""
        },
        uri: toPath
      }
    ],
    output: buildFileChangeOutput(fromPath, diffSummary, { renamed: true, toPath }),
    success: true,
    summary: `${formatFileEditSummary("Renamed", fromPath, diffSummary)} to ${toPath}`
  };
}

export async function executeApplyUnifiedDiff(
  filePatches: UnifiedFilePatch[],
  plans: SandboxFileAccessPlan[],
  dryRun: boolean,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const fileArtifacts: ArtifactDraft[] = [];
  const rollbackArtifacts: ArtifactDraft[] = [];
  const outputs: Array<{ path: string; updated: boolean }> = [];

  for (const [index, filePatch] of filePatches.entries()) {
    const plan = plans[index];
    if (plan === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        message: "Unified diff patch did not resolve to a sandbox plan."
      });
    }
    const targetPath = plan.resolvedPath;
    const originalContent = await fs.readFile(targetPath, "utf8");
    const updatedContent = applyUnifiedPatch(originalContent, filePatch, targetPath);
    if (!dryRun) {
      rollbackArtifacts.push(
        await createRollbackArtifactFromContent(
          targetPath,
          "apply_unified_diff",
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
        dryRun,
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

  const aggregatedDiff = aggregateFileDiffSummaries(
    fileArtifacts.map((artifact) => {
      const content = artifact.content;
      if (typeof content !== "object" || content === null || Array.isArray(content)) {
        return { addedLineCount: 0, changedLineCount: 0, removedLineCount: 0 };
      }
      const diffSummary = content.diffSummary;
      if (typeof diffSummary !== "object" || diffSummary === null || Array.isArray(diffSummary)) {
        return { addedLineCount: 0, changedLineCount: 0, removedLineCount: 0 };
      }
      return {
        addedLineCount: typeof diffSummary.addedLineCount === "number" ? diffSummary.addedLineCount : 0,
        changedLineCount: typeof diffSummary.changedLineCount === "number" ? diffSummary.changedLineCount : 0,
        removedLineCount: typeof diffSummary.removedLineCount === "number" ? diffSummary.removedLineCount : 0
      };
    })
  );
  const action = dryRun ? "Dry run: would apply unified diff to" : "Applied unified diff to";
  return {
    artifacts: [...rollbackArtifacts, ...fileArtifacts],
    output: buildFileChangeOutput(`${outputs.length} files`, aggregatedDiff, {
      dryRun,
      fileCount: outputs.length,
      files: outputs
    }),
    success: true,
    summary: `${action} ${outputs.length} files (${formatDiffLineBadge(aggregatedDiff)})`
  };
}

export function normalizePatchAliases(input: unknown): unknown {
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

export function parseUnifiedDiff(diff: string): UnifiedFilePatch[] {
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

export function resolveUnifiedPatchPath(patch: UnifiedFilePatch): string {
  return patch.newPath === "/dev/null" ? patch.oldPath : patch.newPath;
}

const IGNORED_GLOB_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".next",
  ".turbo",
  ".vscode",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "tmp"
]);

async function walkGlobMatches(
  rootPath: string,
  directoryPath: string,
  pattern: string,
  recursive: boolean,
  maxResults: number,
  matches: Array<{ name: string; path: string; type: "directory" | "file" }>,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    throw new AppError({
      code: "interrupt",
      message: "Glob search interrupted."
    });
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (matches.length >= maxResults) {
      return;
    }

    const nextPath = join(directoryPath, entry.name);
    const relativePath = toRelativePath(rootPath, nextPath);
    if (entry.isDirectory()) {
      if (IGNORED_GLOB_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      if (globToRegExp(pattern).test(normalizePath(relativePath))) {
        matches.push({ name: entry.name, path: nextPath, type: "directory" });
      }
      if (recursive) {
        await walkGlobMatches(rootPath, nextPath, pattern, recursive, maxResults, matches, signal);
      }
      continue;
    }

    if (globToRegExp(pattern).test(normalizePath(relativePath))) {
      matches.push({ name: entry.name, path: nextPath, type: "file" });
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function toRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path);
  return normalizePath(relativePath.length === 0 ? basename(path) : relativePath);
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

function fileWriteDryRunResult(
  targetPath: string,
  operation: FileWriteOperation,
  originalContent: string,
  updatedContent: string
): ToolExecutionResult {
  const diffSummary = summarizeFileChange(originalContent, updatedContent);
  return {
    artifacts: [
      {
        artifactType: "file",
        content: {
          afterText: clipText(updatedContent),
          beforeText: clipText(originalContent),
          diffSummary,
          dryRun: true,
          operation,
          path: targetPath,
          unifiedDiff: createUnifiedDiff(originalContent, updatedContent, targetPath)
        },
        uri: targetPath
      }
    ],
    output: buildFileChangeOutput(targetPath, diffSummary, { dryRun: true }),
    success: true,
    summary: formatFileEditSummary(`Dry run: would ${operation}`, targetPath, diffSummary)
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

function normalizeDiffPath(path: string): string {
  if (path === "/dev/null") {
    return path;
  }
  return path.replace(/^[ab]\//u, "");
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
