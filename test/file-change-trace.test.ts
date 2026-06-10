import { describe, expect, it } from "vitest";

import { extractFileChangeFromArtifacts } from "../src/presentation/file-change-trace.js";

describe("file-change-trace", () => {
  it("extracts fileChange payload from file artifacts", () => {
    const unifiedDiff = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,3 +1,3 @@",
      ...Array.from({ length: 20 }, (_, index) => ` line-${index + 1}`),
      "-old-line",
      "+new-line"
    ].join("\n");
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
      unifiedDiffPreview: [
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,3 +1,3 @@",
        "-old-line",
        "+new-line",
        ...Array.from({ length: 10 }, (_, index) => ` line-${index + 1}`)
      ].join("\n")
    });
  });

  it("returns undefined when no file artifact exists", () => {
    expect(extractFileChangeFromArtifacts([])).toBeUndefined();
  });
});
