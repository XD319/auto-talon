import { describe, expect, it } from "vitest";

import { SchedulerService } from "../src/runtime/scheduler/scheduler-service.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("scheduler service", () => {
  it("enqueues due runs and supports pause/resume/run-now", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        every: "1m",
        input: "hello",
        name: "recurring",
        ownerUserId: "u1",
        providerName: "mock"
      });
      expect(schedule.status).toBe("active");

      const paused = scheduler.pauseSchedule(schedule.scheduleId);
      expect(paused.status).toBe("paused");
      const resumed = scheduler.resumeSchedule(schedule.scheduleId);
      expect(resumed.status).toBe("active");

      const manual = scheduler.runNow(schedule.scheduleId);
      expect(manual.status).toBe("queued");
      expect(manual.trigger).toBe("manual");

      await scheduler.tick(new Date(Date.now() + 70_000));
      const runs = scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 });
      expect(runs.length).toBeGreaterThan(1);
    } finally {
      scheduler.stop();
      storage.close();
    }
  });

  it("edits schedules, archives without deleting runs, and reports status", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const scheduler = new SchedulerService({
      jobRunner: {
        drain: () => Promise.resolve([])
      },
      scheduleRepository: storage.schedules,
      scheduleRunRepository: storage.scheduleRuns,
      traceService
    });

    try {
      const schedule = scheduler.createSchedule({
        agentProfileId: "executor",
        cwd: "/tmp/ws",
        deliveryTargets: ["inbox"],
        every: "30m",
        input: "daily news",
        name: "news",
        ownerUserId: "u1",
        providerName: "mock"
      });
      const edited = scheduler.updateSchedule(schedule.scheduleId, {
        deliveryTargets: ["inbox", "origin"],
        every: "2h",
        input: "updated news",
        name: "updated"
      });
      expect(edited.intervalMs).toBe(7_200_000);
      expect(edited.input).toBe("updated news");
      expect(edited.metadata.delivery).toEqual({ targets: ["inbox", "origin"] });

      const due = scheduler.updateSchedule(schedule.scheduleId, {
        runAt: "2026-01-01T00:00:00.000Z"
      });
      expect(due.nextFireAt).toBe("2026-01-01T00:00:00.000Z");

      await scheduler.tickOnce(new Date("2026-01-01T00:00:01.000Z"));
      expect(scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 })).toHaveLength(1);
      expect(scheduler.status(new Date("2026-01-01T00:00:02.000Z")).runs.queued).toBe(1);

      const archived = scheduler.archiveSchedule(schedule.scheduleId);
      expect(archived.status).toBe("archived");
      expect(storage.schedules.findDue({ now: "2030-01-01T00:00:00.000Z" })).toHaveLength(0);
      expect(scheduler.listScheduleRuns(schedule.scheduleId, { tail: 10 })).toHaveLength(1);
    } finally {
      scheduler.stop();
      storage.close();
    }
  });
});
