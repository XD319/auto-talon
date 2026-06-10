import type { JsonObject } from "../types/common.js";
import { normalizeDiffDisplayPath } from "./file-diff.js";

export interface FileDiffSummary {
  addedLineCount: number;
  changedLineCount: number;
  removedLineCount: number;
}

export function formatDiffLineBadge(
  diffSummary: Pick<FileDiffSummary, "addedLineCount" | "changedLineCount" | "removedLineCount">
): string {
  if (diffSummary.addedLineCount > 0 || diffSummary.removedLineCount > 0) {
    return `+${diffSummary.addedLineCount} -${diffSummary.removedLineCount}`;
  }
  if (diffSummary.changedLineCount > 0) {
    return `~${diffSummary.changedLineCount}`;
  }
  return "+0 -0";
}

export function formatFileEditSummary(
  action: string,
  path: string,
  diffSummary: FileDiffSummary,
  workspaceRoot?: string
): string {
  const displayPath = normalizeDiffDisplayPath(path, workspaceRoot);
  return `${action} ${displayPath} (${formatDiffLineBadge(diffSummary)})`;
}

export function buildFileChangeOutput(
  path: string,
  diffSummary: FileDiffSummary,
  extras: JsonObject = {}
): JsonObject {
  return {
    addedLineCount: diffSummary.addedLineCount,
    changedLineCount: diffSummary.changedLineCount,
    path,
    removedLineCount: diffSummary.removedLineCount,
    ...extras
  };
}

export function aggregateFileDiffSummaries(
  summaries: FileDiffSummary[]
): FileDiffSummary {
  return summaries.reduce(
    (accumulator, summary) => ({
      addedLineCount: accumulator.addedLineCount + summary.addedLineCount,
      changedLineCount: accumulator.changedLineCount + summary.changedLineCount,
      removedLineCount: accumulator.removedLineCount + summary.removedLineCount
    }),
    { addedLineCount: 0, changedLineCount: 0, removedLineCount: 0 }
  );
}
