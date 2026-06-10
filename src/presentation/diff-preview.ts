export function selectDiffPreviewLines(
  unifiedDiff: string,
  maxLines: number
): { hiddenLineCount: number; lines: string[] } {
  if (unifiedDiff.length === 0 || maxLines <= 0) {
    return { hiddenLineCount: 0, lines: [] };
  }

  const allLines = unifiedDiff.split(/\r?\n/u);
  if (allLines.length <= maxLines) {
    return { hiddenLineCount: 0, lines: allLines };
  }

  const headers: string[] = [];
  const changed: string[] = [];
  const context: string[] = [];

  for (const line of allLines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@")) {
      headers.push(line);
      continue;
    }
    if (
      (line.startsWith("+") && !line.startsWith("+++ ")) ||
      (line.startsWith("-") && !line.startsWith("--- "))
    ) {
      changed.push(line);
      continue;
    }
    if (line.startsWith(" ") || line.length === 0) {
      context.push(line);
      continue;
    }
    context.push(line);
  }

  if (headers.length === 0 && changed.length === 0) {
    const lines = allLines.slice(0, maxLines);
    return {
      hiddenLineCount: allLines.length - lines.length,
      lines
    };
  }

  const picked: string[] = [];
  for (const line of headers) {
    if (picked.length >= maxLines) {
      break;
    }
    picked.push(line);
  }
  for (const line of changed) {
    if (picked.length >= maxLines) {
      break;
    }
    picked.push(line);
  }
  for (const line of context) {
    if (picked.length >= maxLines) {
      break;
    }
    picked.push(line);
  }

  return {
    hiddenLineCount: Math.max(0, allLines.length - picked.length),
    lines: picked
  };
}
