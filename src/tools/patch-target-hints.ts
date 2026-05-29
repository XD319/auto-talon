export interface PatchTargetHint {
  fileHead: string;
  nearestMatch: string | null;
  nearestLine: number | null;
  similarityPercent: number | null;
}

export function buildPatchTargetNotFoundMessage(
  targetPath: string,
  findText: string,
  fileContent: string,
  label: "Patch target" | "Target text" = "Patch target"
): { details: PatchTargetHint; message: string } {
  const hint = buildPatchTargetHint(fileContent, findText);
  const findPreview = clipPreview(findText, 240);
  const lines: string[] = [
    `${label} was not found in ${targetPath}.`,
    `${label} find (first 240 chars): ${findPreview}`
  ];

  if (hint.nearestMatch !== null && hint.nearestLine !== null && hint.similarityPercent !== null) {
    lines.push(
      `Nearest match (line ${hint.nearestLine}, similarity ${hint.similarityPercent}%):`,
      hint.nearestMatch
    );
  }

  lines.push(`File head (first 60 lines):`, hint.fileHead);
  lines.push("Hint: Re-read the file before retrying; do not edit from memory.");

  return {
    details: hint,
    message: lines.join("\n")
  };
}

export function buildPatchTargetHint(fileContent: string, findText: string): PatchTargetHint {
  const fileLines = fileContent.split(/\r?\n/u);
  const fileHead = fileLines.slice(0, 60).join("\n");
  const nearest = findNearestLineMatch(fileLines, findText);
  return {
    fileHead,
    nearestLine: nearest?.lineNumber ?? null,
    nearestMatch: nearest?.snippet ?? null,
    similarityPercent: nearest?.similarityPercent ?? null
  };
}

function findNearestLineMatch(
  fileLines: string[],
  findText: string
): { lineNumber: number; similarityPercent: number; snippet: string } | null {
  const findLines = findText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (findLines.length === 0) {
    return null;
  }

  const anchor = findLines[0] ?? "";
  let best:
    | {
        lineNumber: number;
        similarityPercent: number;
        snippet: string;
      }
    | null = null;

  for (let index = 0; index < fileLines.length; index += 1) {
    const line = fileLines[index] ?? "";
    const similarity = jaccardSimilarity(tokenize(line), tokenize(anchor));
    if (best === null || similarity > best.similarityPercent) {
      const start = Math.max(0, index - 2);
      const end = Math.min(fileLines.length, index + 3);
      best = {
        lineNumber: index + 1,
        similarityPercent: Math.round(similarity * 100),
        snippet: fileLines.slice(start, end).join("\n")
      };
    }
  }

  if (best === null || best.similarityPercent < 15) {
    return null;
  }
  return best;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length > 0)
  );
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) {
    return 1;
  }
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function clipPreview(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}...`;
}
