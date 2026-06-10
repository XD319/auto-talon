import { createTwoFilesPatch, structuredPatch } from "diff";

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

export function buildFileDiff(beforeText: string, afterText: string, path: string): FileDiffResult {
  const beforeLines = splitLines(beforeText);
  const afterLines = splitLines(afterText);
  const oldFileName = `a/${path}`;
  const newFileName = `b/${path}`;
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
    createTwoFilesPatch(oldFileName, newFileName, beforeText, afterText, "", "", {
      context: DIFF_CONTEXT
    }),
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

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/\r?\n/u);
}

function clipText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n...[truncated]`;
}
