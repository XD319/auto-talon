import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import type { JsonObject, Provider, ProviderResponse, ProviderRequest } from "../src/types/index.js";

class ScheduledInboxProvider implements Provider {
  public readonly name = "scheduled-inbox-provider";

  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "background done",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

class MetadataCapturingProvider implements Provider {
  public readonly name = "metadata-capturing-provider";
  public taskMetadata: JsonObject | null = null;

  public generate(input: ProviderRequest): Promise<ProviderResponse> {
    this.taskMetadata = input.task.metadata;
    return Promise.resolve({
      kind: "final",
      message: "captured",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("schedule inbox e2e", () => {
  it("writes inbox item when background run completes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-inbox-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScheduledInboxProvider(),
      scheduler: { autoStart: false }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        every: "1m",
        input: "run background action",
        name: "inbox schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      const runs = handle.service.listScheduleRuns(schedule.scheduleId, { tail: 20 });
      const completed = runs.find((run) => run.status === "completed");
      expect(completed?.taskId).toBeTruthy();

      const inboxItems = handle.service.listInbox({ taskId: completed?.taskId, userId: "local-user" });
      expect(inboxItems.some((item) => item.category === "task_completed")).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("skips inbox items when delivery target is silent", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-silent-inbox-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScheduledInboxProvider(),
      scheduler: { autoStart: false }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        deliveryTargets: ["silent"],
        every: "1m",
        input: "run silent action",
        name: "silent schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      const runs = handle.service.listScheduleRuns(schedule.scheduleId, { tail: 20 });
      const completed = runs.find((run) => run.status === "completed");
      expect(completed?.taskId).toBeTruthy();

      const inboxItems = handle.service.listInbox({ userId: "local-user" });
      expect(inboxItems.some((item) => item.scheduleRunId === completed?.runId)).toBe(false);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("skips inbox items when delivery target is origin only", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-origin-only-inbox-e2e-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new ScheduledInboxProvider(),
      scheduler: { autoStart: false }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        deliveryTargets: ["origin"],
        every: "1m",
        input: "run origin-only action",
        metadata: {
          origin: {
            adapter: "feishu-im",
            chatId: "chat-1"
          }
        },
        name: "origin-only schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      const runs = handle.service.listScheduleRuns(schedule.scheduleId, { tail: 20 });
      const completed = runs.find((run) => run.status === "completed");
      expect(completed?.taskId).toBeTruthy();
      expect(handle.service.listInbox({ userId: "local-user" })).toHaveLength(0);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("marks scheduled run task metadata to disallow recursive schedule creation", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-schedule-metadata-e2e-"));
    const provider = new MetadataCapturingProvider();
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider,
      scheduler: { autoStart: false }
    });
    try {
      const schedule = handle.service.createSchedule({
        agentProfileId: "executor",
        cwd: workspace,
        every: "1m",
        input: "capture metadata",
        name: "metadata schedule",
        ownerUserId: "local-user",
        providerName: handle.config.provider.name
      });
      handle.service.runScheduleNow(schedule.scheduleId);
      await handle.service.tickScheduleOnce();

      expect(provider.taskMetadata?.scheduleRunContext).toMatchObject({
        disallowScheduleManagement: true,
        scheduleId: schedule.scheduleId
      });
      expect(typeof (provider.taskMetadata?.scheduleRunContext as Record<string, unknown> | undefined)?.runId).toBe("string");
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
