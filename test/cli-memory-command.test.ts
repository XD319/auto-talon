import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";

describe("cli memory commands", () => {
  it("supports layered scopes and legacy aliases", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cli-memory-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(workspace);
      await main(["node", "talon", "run", "collect memory context"]);

      await main(["node", "talon", "memory", "list", "--scope", "project"]);
      await main(["node", "talon", "memory", "show", "skill_ref"]);
      await main(["node", "talon", "memory", "show", "session", "--task-id", "missing-task"]);
      await main(["node", "talon", "thread", "list", "--json"]);
      const threadListLog = logSpy.mock.calls
        .map((entry) => String(entry[0] ?? ""))
        .find((entry) => entry.startsWith("["));
      const firstThreadId =
        threadListLog === undefined
          ? null
          : ((JSON.parse(threadListLog) as Array<{ threadId: string }>)[0]?.threadId ?? null);
      expect(firstThreadId).not.toBeNull();
      await main(["node", "talon", "memory", "search", "collect memory context", "--thread", firstThreadId!]);
      await main(["node", "talon", "memory", "search", "last time memory context", "--global"]);

      const output = logSpy.mock.calls.map((entry) => String(entry[0] ?? "")).join("\n");
      expect(output).toContain("No enabled skills found.");
      expect(output).toContain("Scope: working");
      expect(
        output.includes("No session memory hits found.") || output.includes("thread=")
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
