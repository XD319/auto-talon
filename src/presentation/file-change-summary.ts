import type { JsonObject } from "../types/common.js";

export interface FileDiffSummary {
  addedLineCount: number;
  changedLineCount: number;
  removedLineCount: number;
}

export function formatDiffLineBadge(
  diffSummary: Pick<FileDiffSummary, "addedLineCount" | "removedLineCount">
): string {
  return `+${diffSummary.addedLineCount} -${diffSummary.removedLineCount}`;
}

export function formatFileEditSummary(action: string, path: string, diffSummary: FileDiffSummary): string {
  return `${action} ${path} (${formatDiffLineBadge(diffSummary)})`;
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
