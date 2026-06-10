import { describe, expect, it } from "vitest";

import { selectDiffPreviewLines } from "../src/presentation/diff-preview.js";

describe("selectDiffPreviewLines", () => {
  it("prioritizes changed lines over leading context", () => {
    const unifiedDiff = [
      "--- a/index.html",
      "+++ b/index.html",
      "@@ -20,3 +20,3 @@",
      " context-before",
      "-old-line",
      "+new-line",
      " context-after"
    ].join("\n");

    const result = selectDiffPreviewLines(unifiedDiff, 6);

    expect(result.lines).toEqual([
      "--- a/index.html",
      "+++ b/index.html",
      "@@ -20,3 +20,3 @@",
      "-old-line",
      "+new-line",
      " context-before"
    ]);
    expect(result.hiddenLineCount).toBe(1);
  });
});
