import { describe, expect, it } from "vitest";

import { extractFileChangeFromArtifacts } from "../src/presentation/file-change-trace.js";

describe("file-change-trace", () => {
  it("extracts fileChange payload from file artifacts", () => {
    const unifiedDiff = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    const fileChange = extractFileChangeFromArtifacts([
      {
        artifactType: "file_rollback",
        content: { path: "src/app.ts" },
        uri: "rollback:src/app.ts"
      },
      {
        artifactType: "file",
        content: {
          diffSummary: {
            addedLineCount: 12,
            changedLineCount: 8,
            removedLineCount: 3
          },
          path: "src/app.ts",
          unifiedDiff
        },
        uri: "src/app.ts"
      }
    ]);

    expect(fileChange).toEqual({
      addedLineCount: 12,
      changedLineCount: 8,
      path: "src/app.ts",
      removedLineCount: 3,
      unifiedDiffPreview: Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n")
    });
  });

  it("returns undefined when no file artifact exists", () => {
    expect(extractFileChangeFromArtifacts([])).toBeUndefined();
  });
});
