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
      " context-before",
      "-old-line",
      "+new-line"
    ]);
    expect(result.hiddenLineCount).toBe(1);
  });

  it("shows +/- lines for multi-hunk refactors instead of only hunk headers", () => {
    const unifiedDiff = [
      "--- a/test/integration.test.js",
      "+++ b/test/integration.test.js",
      "@@ -3,186 +3,34 @@",
      "@@ -195,7 +43,7 @@",
      "@@ -211,7 +59,7 @@",
      "@@ -242,7 +90,7 @@",
      "@@ -264,7 +112,7 @@",
      "@@ -281,7 +129,7 @@",
      "@@ -300,7 +148,7 @@",
      "@@ -329,7 +177,7 @@",
      "@@ -349,7 +197,7 @@",
      "@@ -374,7 +222,7 @@",
      "@@ -428,8 +276,5 @@",
      "-// ==================== 测试框架 ====================",
      "+// ==================== 加载测试工具 ====================",
      ...Array.from({ length: 20 }, (_, index) => ` context-tail-${index + 1}`)
    ].join("\n");

    const result = selectDiffPreviewLines(unifiedDiff, 15);

    expect(result.lines.some((line) => line.startsWith("-"))).toBe(true);
    expect(result.lines.some((line) => line.startsWith("+"))).toBe(true);
    expect(result.lines.filter((line) => line.startsWith("@@")).length).toBeLessThan(10);
  });

  it("skips no-op +/- pairs that look identical in the terminal", () => {
    const unifiedDiff = [
      "--- a/index.html",
      "+++ b/index.html",
      "@@ -82,7 +82,7 @@",
      "     <script src=\"js/config.js\"></script>",
      "-    <script src=\"js/particles.js\"></script>",
      "+    <script src=\"js/animation.js\"></script>",
      "     <script src=\"js/snake.js\"></script>",
      "@@ -93,4 +93,4 @@",
      "     <script src=\"js/state.js\"></script>",
      "-</html>",
      "+</html>",
      " </body>"
    ].join("\n");

    const result = selectDiffPreviewLines(unifiedDiff, 15);

    expect(result.lines).not.toContain("-</html>");
    expect(result.lines).not.toContain("+</html>");
    expect(result.lines).toContain('-    <script src="js/particles.js"></script>');
    expect(result.lines).toContain('+    <script src="js/animation.js"></script>');
  });

  it("skips separator noise lines", () => {
    const unifiedDiff = [
      "===================================================================",
      "--- a/js/config.js",
      "+++ b/js/config.js",
      "@@ -86,3 +86,8 @@",
      " };",
      "+",
      "+// export",
      "Index: deadbeef",
      ...Array.from({ length: 12 }, (_, index) => ` context-${index + 1}`)
    ].join("\n");

    const result = selectDiffPreviewLines(unifiedDiff, 8);

    expect(result.lines.some((line) => /^=+$/u.test(line.trim()))).toBe(false);
    expect(result.lines.some((line) => line.startsWith("Index:"))).toBe(false);
    expect(result.lines).toContain("+// export");
  });
});
