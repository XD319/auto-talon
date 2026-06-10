import { describe, expect, it } from "vitest";

import {
  aggregateFileDiffSummaries,
  buildFileChangeOutput,
  formatDiffLineBadge,
  formatFileEditSummary
} from "../src/presentation/file-change-summary.js";

describe("file-change-summary", () => {
  const diffSummary = {
    addedLineCount: 12,
    changedLineCount: 8,
    removedLineCount: 3
  };

  it("formats diff line badge", () => {
    expect(formatDiffLineBadge(diffSummary)).toBe("+12 -3");
    expect(formatDiffLineBadge({ addedLineCount: 0, removedLineCount: 5, changedLineCount: 5 })).toBe("+0 -5");
    expect(formatDiffLineBadge({ addedLineCount: 0, removedLineCount: 0, changedLineCount: 4 })).toBe("~4");
    expect(formatDiffLineBadge({ addedLineCount: 0, removedLineCount: 0, changedLineCount: 0 })).toBe("+0 -0");
  });

  it("formats file edit summary with badge", () => {
    expect(formatFileEditSummary("Wrote", "src/app.ts", diffSummary)).toBe("Wrote src/app.ts (+12 -3)");
  });

  it("formats file edit summary with workspace-relative paths", () => {
    expect(
      formatFileEditSummary(
        "Wrote",
        "D:\\workspace\\talon-test\\js\\animation.js",
        diffSummary,
        "D:\\workspace\\talon-test"
      )
    ).toBe("Wrote js/animation.js (+12 -3)");
  });

  it("builds standard file change output", () => {
    expect(buildFileChangeOutput("src/app.ts", diffSummary, { size: 42 })).toEqual({
      addedLineCount: 12,
      changedLineCount: 8,
      path: "src/app.ts",
      removedLineCount: 3,
      size: 42
    });
  });

  it("aggregates diff summaries across files", () => {
    expect(
      aggregateFileDiffSummaries([
        { addedLineCount: 2, changedLineCount: 1, removedLineCount: 1 },
        { addedLineCount: 3, changedLineCount: 2, removedLineCount: 0 }
      ])
    ).toEqual({
      addedLineCount: 5,
      changedLineCount: 3,
      removedLineCount: 1
    });
  });
});
