import { describe, expect, it } from "vitest";

import { collectPlatformToolIssues } from "../src/runtime/operations/runtime-doctor-service.js";

describe("runtime doctor platform issues", () => {
  it("warns when ripgrep is missing on Windows", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: (command) => command !== "rg",
      platform: "win32"
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining("ripgrep (rg) is not on PATH")])
    );
  });

  it("warns when git is missing on Windows", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: (command) => command !== "git",
      platform: "win32"
    });
    expect(issues).toEqual(
      expect.arrayContaining([expect.stringContaining("git is not on PATH")])
    );
  });

  it("does not warn on non-Windows platforms", () => {
    const issues = collectPlatformToolIssues({
      isCommandAvailable: () => false,
      platform: "linux"
    });
    expect(issues).toEqual([]);
  });
});
