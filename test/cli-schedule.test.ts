import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { createApplication } from "../src/runtime/index.js";

describe("cli schedule commands", () => {
  it("supports create/list/edit/pause/resume/run-now/status/tick/remove flows", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cli-schedule-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(workspace);
      await main(["node", "talon", "schedule", "create", "hello from cli", "--name", "cli", "--every", "5m"]);
      await main(["node", "talon", "schedule", "list"]);
      const listOutput = logSpy.mock.calls.map((entry) => String(entry[0] ?? ""));
      const line = listOutput.find((entry) => entry.includes(" | ") && entry.includes(" | cli"));
      expect(line).toBeTruthy();
      const scheduleId = line?.split(" | ")[0];
      expect(scheduleId).toBeTruthy();

      await main(["node", "talon", "schedule", "pause", scheduleId!]);
      await main(["node", "talon", "schedule", "resume", scheduleId!]);
      await main(["node", "talon", "schedule", "edit", scheduleId!, "--name", "cli edited", "--input", "edited prompt", "--every", "10m"]);
      await main(["node", "talon", "schedule", "preview", "every 15m", "--count", "2"]);
      await main(["node", "talon", "schedule", "run-now", scheduleId!]);
      await main(["node", "talon", "schedule", "runs", scheduleId!, "--tail", "5"]);
      await main(["node", "talon", "schedule", "status"]);
      await main(["node", "talon", "schedule", "tick"]);
      await main(["node", "talon", "schedule", "remove", scheduleId!]);
      await main(["node", "talon", "schedule", "list", "--status", "archived"]);
      const allOutput = logSpy.mock.calls.map((entry) => String(entry[0] ?? "")).join("\n");
      expect(allOutput).toContain("cli edited");
      expect(allOutput).toContain("Timing: every");
      expect(allOutput).toContain("Schedules:");
      expect(allOutput).toContain("archived");
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("creates schedules in the workspace passed through --cwd", async () => {
    const commandWorkspace = mkdtempSync(join(tmpdir(), "talon-cli-schedule-command-"));
    const targetWorkspace = mkdtempSync(join(tmpdir(), "talon-cli-schedule-target-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(commandWorkspace);
      await main([
        "node",
        "talon",
        "schedule",
        "create",
        "hello target workspace",
        "--name",
        "target schedule",
        "--every",
        "5m",
        "--cwd",
        targetWorkspace
      ]);

      const targetHandle = createApplication(targetWorkspace);
      const commandHandle = createApplication(commandWorkspace);
      try {
        const targetSchedules = targetHandle.service.listSchedules();
        const commandSchedules = commandHandle.service.listSchedules();
        expect(targetSchedules).toHaveLength(1);
        expect(targetSchedules[0]?.name).toBe("target schedule");
        expect(targetSchedules[0]?.cwd).toBe(targetWorkspace);
        expect(targetSchedules[0]?.providerName).toBe(targetHandle.config.provider.name);
        expect(commandSchedules).toHaveLength(0);
      } finally {
        targetHandle.close();
        commandHandle.close();
      }
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(commandWorkspace, { force: true, recursive: true });
      rmSync(targetWorkspace, { force: true, recursive: true });
    }
  });
});
