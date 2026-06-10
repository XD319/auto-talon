import { formatDiffLineBadge as formatPlainDiffLineBadge } from "../../presentation/file-change-summary.js";
import { selectDiffPreviewLines } from "../../presentation/diff-preview.js";
import { gray, green, red } from "../ansi.js";
import { theme } from "../theme.js";

export const DEFAULT_DIFF_PANEL_MAX_LINES = 40;
export const DEFAULT_SCROLLBACK_DIFF_MAX_LINES = 15;

export type DiffLineKind = "added" | "context" | "header" | "removed";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
    return "header";
  }
  if (line.startsWith("+")) {
    return "added";
  }
  if (line.startsWith("-")) {
    return "removed";
  }
  return "context";
}

export function summarizeDiffLines(
  unifiedDiff: string,
  maxLines: number = DEFAULT_DIFF_PANEL_MAX_LINES
): { hiddenLineCount: number; visibleLines: string[] } {
  const { hiddenLineCount, lines } = selectDiffPreviewLines(unifiedDiff, maxLines);
  return {
    hiddenLineCount,
    visibleLines: lines
  };
}

export function formatDiffLineBadge(
  addedLineCount: number,
  removedLineCount: number,
  changedLineCount = 0
): string {
  const badge = formatPlainDiffLineBadge({ addedLineCount, changedLineCount, removedLineCount });
  if (badge.startsWith("~")) {
    return badge;
  }
  const match = /^\+(\d+) -(\d+)$/u.exec(badge);
  if (match === null) {
    return badge;
  }
  return `${green(`+${match[1]}`)} ${red(`-${match[2]}`)}`;
}

export function colorizeDiffLine(line: string): string {
  switch (classifyDiffLine(line)) {
    case "header":
      return gray(line);
    case "added":
      return green(line);
    case "removed":
      return red(line);
    default:
      return line;
  }
}

export function diffLineProps(line: string): { color?: string } {
  switch (classifyDiffLine(line)) {
    case "header":
      return { color: theme.muted };
    case "added":
      return { color: theme.success };
    case "removed":
      return { color: theme.danger };
    default:
      return {};
  }
}

export function formatScrollbackDiffPreview(
  unifiedDiff: string,
  options: { maxLines?: number; prefix?: string } = {}
): string {
  const maxLines = options.maxLines ?? DEFAULT_SCROLLBACK_DIFF_MAX_LINES;
  const prefix = options.prefix ?? "┊   ";
  if (unifiedDiff.length === 0) {
    return "";
  }

  const { hiddenLineCount, visibleLines } = summarizeDiffLines(unifiedDiff, maxLines);
  const lines = visibleLines.map((line) => `${prefix}${colorizeDiffLine(line)}`);
  if (hiddenLineCount > 0) {
    lines.push(`${prefix}${gray(`... ${hiddenLineCount} more lines (use /diff)`)}`);
  }
  return `${lines.join("\n")}\n`;
}
