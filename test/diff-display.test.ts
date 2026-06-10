import { describe, expect, it } from "vitest";

import {
  resolveCommandDiffMaxLines,
  resolveScrollbackPreviewMaxLines
} from "../src/presentation/diff-display.js";

describe("diff display verbosity", () => {
  it("maps display modes to preview limits", () => {
    expect(resolveScrollbackPreviewMaxLines("summary")).toBe(0);
    expect(resolveScrollbackPreviewMaxLines("collapsed")).toBe(15);
    expect(resolveScrollbackPreviewMaxLines("full")).toBe(40);
    expect(resolveCommandDiffMaxLines("collapsed")).toBe(40);
    expect(resolveCommandDiffMaxLines("full")).toBe(200);
  });
});
