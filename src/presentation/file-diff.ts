import { createTwoFilesPatch, structuredPatch } from "diff";
import { relative, sep } from "node:path";

import type { JsonObject } from "../types/common.js";
import type { FileDiffSummary } from "./file-change-summary.js";

const DIFF_CONTEXT = 3;
const MAX_UNIFIED_DIFF_BYTES = 12_000;

export type FileDiffSummaryRecord = FileDiffSummary & {
  afterLineCount: number;
  beforeLineCount: number;
} & JsonObject;

export interface FileDiffResult {
  diffSummary: FileDiffSummaryRecord;
  unifiedDiff: string;
}

export interface BuildFileDiffOptions {
  workspaceRoot?: string;
}

export function buildFileDiff(
  beforeText: string,
  afterText: string,
  path: string,
  options: BuildFileDiffOptions = {}
): FileDiffResult {
  const displayPath = normalizeDiffDisplayPath(path, options.workspaceRoot);
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const oldFileName = `a/${displayPath}`;
  const newFileName = `b/${displayPath}`;
  const patch = structuredPatch(oldFileName, newFileName, beforeText, afterText, "", "", {
    context: DIFF_CONTEXT
  });

  let addedLineCount = 0;
  let removedLineCount = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        addedLineCount += 1;
      } else if (line.startsWith("-")) {
        removedLineCount += 1;
      }
    }
  }

  const changedLineCount = addedLineCount + removedLineCount;
  const unifiedDiff = clipText(
    stripDiffNoise(
      createTwoFilesPatch(oldFileName, newFileName, beforeText, afterText, "", "", {
        context: DIFF_CONTEXT
      })
    ),
    MAX_UNIFIED_DIFF_BYTES
  );

  const diffSummary: FileDiffSummaryRecord = {
    addedLineCount,
    afterLineCount: afterLines.length,
    beforeLineCount: beforeLines.length,
    changedLineCount,
    removedLineCount
  };

  return {
    diffSummary,
    unifiedDiff
  };
}

export function extractPathFromDiffHeader(diff: string): string | undefined {
  const match = /^--- a\/(.+?)(?:\t|$)/mu.exec(diff);
  return match?.[1];
}

export function resolveFileChangeDisplayPath(
  path: string,
  options: { unifiedDiffPreview?: string; workspaceRoot?: string } = {}
): string {
  const fromDiff = extractPathFromDiffHeader(options.unifiedDiffPreview ?? "");
  if (fromDiff !== undefined && fromDiff.length > 0) {
    return fromDiff;
  }
  return normalizeDiffDisplayPath(path, options.workspaceRoot);
}

export function normalizeDiffDisplayPath(path: string, workspaceRoot?: string): string {
  const normalized = path.replace(/\\/gu, "/");
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    return normalized;
  }
  const normalizedRoot = workspaceRoot.replace(/\\/gu, "/").replace(/\/$/u, "");
  if (!isCrossPlatformAbsolute(normalized)) {
    return normalized;
  }
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  try {
    return relative(workspaceRoot, path).split(sep).join("/");
  } catch {
    return normalized;
  }
}

function isCrossPlatformAbsolute(normalizedPath: string): boolean {
  return normalizedPath.startsWith("/") || /^[A-Za-z]:\//u.test(normalizedPath);
}

function stripDiffNoise(diff: string): string {
  return diff
    .split(/\r?\n/u)
    .filter((line) => !/^=+$/u.test(line.trim()) && !line.startsWith("Index:"))
    .join("\n");
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r?\n/u);
}

function clipText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}
