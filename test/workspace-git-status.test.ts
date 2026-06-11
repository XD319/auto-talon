import { afterEach, describe, expect, it, vi } from "vitest";

import { runGitReadOnly } from "../src/runtime/workspace/git-readonly.js";
import {
  clearGitBranchStatusCache,
  formatGitBranchLabel,
  readGitBranchStatus
} from "../src/tui/workspace-git-status.js";

vi.mock("../src/runtime/workspace/git-readonly.js", () => ({
  runGitReadOnly: vi.fn()
}));

describe("workspace git status", () => {
  afterEach(() => {
    clearGitBranchStatusCache();
    vi.resetAllMocks();
  });

  it("returns branch and dirty flag", () => {
    vi.mocked(runGitReadOnly).mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") {
        return { error: null, output: "feature/status-line\n" };
      }
      return { error: null, output: " M src/app.ts\n" };
    });

    expect(readGitBranchStatus("/repo")).toEqual({
      branch: "feature/status-line",
      dirty: true
    });
    expect(formatGitBranchLabel({ branch: "feature/status-line", dirty: true })).toBe("feature/status-line*");
  });

  it("returns null when git is unavailable", () => {
    vi.mocked(runGitReadOnly).mockReturnValue({ error: "not a git repository", output: "" });
    expect(readGitBranchStatus("/repo")).toBeNull();
  });

  it("caches results for five seconds", () => {
    vi.mocked(runGitReadOnly).mockImplementation((_cwd, args) => {
      if (args[0] === "rev-parse") {
        return { error: null, output: "main\n" };
      }
      return { error: null, output: "" };
    });

    expect(readGitBranchStatus("/repo", 1_000)).toEqual({ branch: "main", dirty: false });
    expect(readGitBranchStatus("/repo", 4_000)).toEqual({ branch: "main", dirty: false });
    expect(runGitReadOnly).toHaveBeenCalledTimes(2);

    expect(readGitBranchStatus("/repo", 6_001)).toEqual({ branch: "main", dirty: false });
    expect(runGitReadOnly).toHaveBeenCalledTimes(4);
  });
});
