import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";

describe("schedule no_agent e2e", () => {
  it("runs script-only schedules without invoking the provider", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-no-agent-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      scheduler: { autoStart: false }
    });
    try {
      const command =
        process.platform === "win32" ? "echo no-agent-ok" : "printf 'no-agent-ok'";
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        every: "1m",
        input: "unused prompt",
        name: "no-agent schedule",
        noAgent: { command },
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      const completed = handle.service
        .listScheduleRuns(schedule.scheduleId, { tail: 5 })
        .find((run) => run.status === "completed");
      expect(completed).toBeTruthy();
      expect(completed?.taskId).toBeNull();
      expect(String(completed?.metadata.noAgentOutput ?? "")).toContain("no-agent-ok");
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
