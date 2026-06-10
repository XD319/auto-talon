type DiffPreviewLineKind =
  | "added"
  | "context"
  | "file_header"
  | "hunk_header"
  | "noise"
  | "removed";

interface DiffHunk {
  bodyIndices: number[];
  headerIndex: number;
}

export function selectDiffPreviewLines(
  unifiedDiff: string,
  maxLines: number
): { hiddenLineCount: number; lines: string[] } {
  if (unifiedDiff.length === 0 || maxLines <= 0) {
    return { hiddenLineCount: 0, lines: [] };
  }

  const allLines = unifiedDiff.split(/\r?\n/u);
  const kinds = allLines.map(classifyDiffPreviewLine);

  if (allLines.length <= maxLines) {
    const lines = filterDiffPreviewLines(allLines, kinds);
    return {
      hiddenLineCount: allLines.length - lines.length,
      lines
    };
  }
  const hasDiffStructure = kinds.some(
    (kind) => kind === "file_header" || kind === "hunk_header" || kind === "added" || kind === "removed"
  );
  if (!hasDiffStructure) {
    const lines = allLines.slice(0, maxLines);
    return {
      hiddenLineCount: allLines.length - lines.length,
      lines
    };
  }

  const hunks = buildDiffHunks(allLines, kinds);
  const include = new Set<number>();

  let fileHeaders = 0;
  for (let index = 0; index < allLines.length; index++) {
    if (kinds[index] !== "file_header") {
      continue;
    }
    include.add(index);
    fileHeaders += 1;
    if (fileHeaders >= 2) {
      break;
    }
  }

  for (let index = 0; index < allLines.length; index++) {
    if (include.size >= maxLines) {
      break;
    }
    if (isSelectableChangeLine(index, kinds, allLines)) {
      include.add(index);
    }
  }

  for (const hunk of hunks) {
    if (include.size >= maxLines) {
      break;
    }
    const hasSelectedChange = hunk.bodyIndices.some(
      (index) => include.has(index) && (kinds[index] === "added" || kinds[index] === "removed")
    );
    if (hasSelectedChange && !include.has(hunk.headerIndex)) {
      include.add(hunk.headerIndex);
    }
  }

  for (const hunk of hunks) {
    const hasSelectedChange = hunk.bodyIndices.some(
      (index) => include.has(index) && (kinds[index] === "added" || kinds[index] === "removed")
    );
    if (!hasSelectedChange) {
      continue;
    }
    const hunkLines = [hunk.headerIndex, ...hunk.bodyIndices];
    for (const index of hunkLines) {
      if (include.size >= maxLines) {
        break;
      }
      if (kinds[index] === "context" && !include.has(index)) {
        include.add(index);
      }
    }
  }

  const lines: string[] = [];
  for (let index = 0; index < allLines.length; index++) {
    if (include.has(index)) {
      lines.push(allLines[index] ?? "");
    }
  }

  return {
    hiddenLineCount: Math.max(0, allLines.length - lines.length),
    lines
  };
}

function filterDiffPreviewLines(allLines: string[], kinds: DiffPreviewLineKind[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < allLines.length; index++) {
    const kind = kinds[index];
    if (kind === "noise" || (kind !== undefined && isNoOpChangeLine(index, kinds, allLines))) {
      continue;
    }
    lines.push(allLines[index] ?? "");
  }
  return lines;
}

function isSelectableChangeLine(
  index: number,
  kinds: DiffPreviewLineKind[],
  allLines: string[]
): boolean {
  const kind = kinds[index];
  return (kind === "added" || kind === "removed") && !isNoOpChangeLine(index, kinds, allLines);
}

function isNoOpChangeLine(
  index: number,
  kinds: DiffPreviewLineKind[],
  allLines: string[]
): boolean {
  const kind = kinds[index];
  if (kind !== "added" && kind !== "removed") {
    return false;
  }
  const body = (allLines[index] ?? "").slice(1);
  const opposite = kind === "added" ? "removed" : "added";
  for (let otherIndex = 0; otherIndex < allLines.length; otherIndex++) {
    if (kinds[otherIndex] !== opposite) {
      continue;
    }
    const otherBody = (allLines[otherIndex] ?? "").slice(1);
    if (otherBody === body) {
      return true;
    }
    if (otherBody.trim() === body.trim() && body.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function classifyDiffPreviewLine(line: string): DiffPreviewLineKind {
  if (/^=+$/u.test(line.trim())) {
    return "noise";
  }
  if (line.startsWith("Index:")) {
    return "noise";
  }
  if (line.startsWith("--- ")) {
    return "file_header";
  }
  if (line.startsWith("+++ ")) {
    return "file_header";
  }
  if (line.startsWith("@@")) {
    return "hunk_header";
  }
  if (line.startsWith("+")) {
    return "added";
  }
  if (line.startsWith("-")) {
    return "removed";
  }
  if (line.startsWith(" ") || line.length === 0) {
    return "context";
  }
  return "context";
}

function buildDiffHunks(allLines: string[], kinds: DiffPreviewLineKind[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (let index = 0; index < allLines.length; index++) {
    const kind = kinds[index];
    if (kind === "noise") {
      continue;
    }
    if (kind === "hunk_header") {
      if (current !== null) {
        hunks.push(current);
      }
      current = { bodyIndices: [], headerIndex: index };
      continue;
    }
    if (current !== null) {
      current.bodyIndices.push(index);
    }
  }

  if (current !== null) {
    hunks.push(current);
  }

  return hunks;
}
