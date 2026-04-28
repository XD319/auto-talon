import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import type { Provider } from "../src/types/index.js";

class FailingScheduledProvider implements Provider {
  public readonly name = "failing-scheduled-provider";

  public generate(): Promise<never> {
    throw new Error("routine exploded");
  }
}

describe("schedule failure e2e", () => {
  it("blocks the bound thread when a scheduled routine fails", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-failure-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new FailingScheduledProvider(),
      scheduler: { autoStart: true }
    });
    try {
      const thread = handle.service.createThread({
        agentProfileId: "executor",
        cwd: workspace,
        ownerUserId: "local-user",
        providerName: handle.config.provider.name,
        title: "Routine thread"
      });
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        every: "1m",
        input: "run failing routine",
        name: "Threaded routine",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name,
        threadId: thread.threadId
      });
      handle.service.runScheduleNow(schedule.scheduleId);

      await new Promise((resolve) => setTimeout(resolve, 2500));
      const runs = handle.service.listScheduleRuns(schedule.scheduleId, { tail: 20 });
      expect(runs.some((run) => run.status === "failed")).toBe(true);

      const threadView = handle.service.showThread(thread.threadId);
      expect(threadView.state.blockedReason).toContain("routine exploded");
      expect(
        threadView.nextActions.some((item) => item.title === "Follow up failed routine: Threaded routine")
      ).toBe(true);
      expect(threadView.inboxItems.some((item) => item.category === "task_blocked")).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
