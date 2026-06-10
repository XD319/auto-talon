import { describe, expect, it } from "vitest";

import { buildFileDiff } from "../src/presentation/file-diff.js";

describe("buildFileDiff", () => {
  it("reports full addition for new files", () => {
    const content = "line one\nline two";
    const result = buildFileDiff("", content, "src/new.ts");

    expect(result.diffSummary).toMatchObject({
      addedLineCount: 2,
      beforeLineCount: 0,
      afterLineCount: 2,
      changedLineCount: 2,
      removedLineCount: 0
    });
    expect(result.unifiedDiff).toContain("+line one");
    expect(result.unifiedDiff).not.toContain("-line one");
  });

  it("reports removals and additions when overwriting an existing file", () => {
    const before = Array.from({ length: 5 }, (_, index) => `old-${index + 1}`).join("\n");
    const after = "new-1\nnew-2\n";
    const result = buildFileDiff(before, after, "src/app.ts");

    expect(result.diffSummary.addedLineCount).toBeGreaterThan(0);
    expect(result.diffSummary.removedLineCount).toBeGreaterThan(0);
    expect(result.unifiedDiff).toMatch(/-old-/u);
    expect(result.unifiedDiff).toMatch(/\+new-/u);
  });

  it("reports single-line replacement as +1 -1", () => {
    const before = "alpha\nbeta\n";
    const after = "alpha\ngamma\n";
    const result = buildFileDiff(before, after, "src/app.ts");

    expect(result.diffSummary).toMatchObject({
      addedLineCount: 1,
      removedLineCount: 1,
      changedLineCount: 2
    });
    expect(result.unifiedDiff).toContain("-beta");
    expect(result.unifiedDiff).toContain("+gamma");
  });

  it("places middle-of-file changes in the patch hunk", () => {
    const before = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`).join("\n");
    const lines = before.split("\n");
    lines[20] = "changed-line";
    const after = lines.join("\n");
    const result = buildFileDiff(before, after, "index.html");

    expect(result.unifiedDiff).toContain("-line-21");
    expect(result.unifiedDiff).toContain("+changed-line");
  });
});
