import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { DiffViewModel } from "../view-models/runtime-dashboard.js";

export interface DiffPanelProps {
  diff: DiffViewModel[];
}
const MAX_DIFF_LINES = 40;

export function summarizeDiffLines(unifiedDiff: string): { hiddenLineCount: number; visibleLines: string[] } {
  const diffLines = unifiedDiff.split(/\r?\n/u);
  return {
    hiddenLineCount: Math.max(0, diffLines.length - MAX_DIFF_LINES),
    visibleLines: diffLines.slice(0, MAX_DIFF_LINES)
  };
}

export function DiffPanel({ diff }: DiffPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>File Diff</Text>
      {diff.length === 0 ? (
        <Text color={theme.muted}>No file write artifacts for this task.</Text>
      ) : (
        diff.map((entry) => {
          const { hiddenLineCount, visibleLines } = summarizeDiffLines(entry.unifiedDiff);
          return (
            <Box key={entry.artifactId} borderStyle="classic" borderColor={theme.border} marginBottom={1} flexDirection="column" paddingX={1}>
              <Text color={entry.riskHighlight ? theme.danger : theme.success}>
                {entry.path} | {entry.summary}
              </Text>
              {entry.riskReasons.length > 0 ? (
                <Text color={theme.warn} wrap="wrap">
                  risk: {entry.riskReasons.join("; ")}
                </Text>
              ) : null}
              {entry.unifiedDiff.length > 0 ? (
                <>
                  {visibleLines.map((line, index) => (
                    <Text key={`${entry.artifactId}-diff-${index}`} {...diffLineProps(line)}>
                      {line}
                    </Text>
                  ))}
                  {hiddenLineCount > 0 ? (
                    <Text color={theme.warn}>... {hiddenLineCount} more lines (truncated)</Text>
                  ) : null}
                </>
              ) : (
                <>
                  <Text color={theme.muted}>before: {entry.beforePreview.replace(/\n/gu, " ")}</Text>
                  <Text color={theme.muted}>after: {entry.afterPreview.replace(/\n/gu, " ")}</Text>
                </>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}

function diffLineProps(line: string): { color?: string } {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
    return { color: theme.muted };
  }
  if (line.startsWith("+")) {
    return { color: theme.success };
  }
  if (line.startsWith("-")) {
    return { color: theme.danger };
  }
  return {};
}
