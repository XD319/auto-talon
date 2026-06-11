import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { CronjobTool } from "../src/tools/cronjob-tool.js";
import type { Provider, ProviderResponse } from "../src/types/index.js";
import type { ToolExecutionContext } from "../src/types/index.js";

class CronjobProvider implements Provider {
  public readonly name = "cronjob-provider";

  public generate(): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: "done",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("CronjobTool", () => {
  it("returns unavailable when port is not bound", async () => {
    const tool = new CronjobTool();
    const prepared = tool.prepare({
      action: "create",
      every: "1h",
      name: "test",
      prompt: "run task"
    });
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe("tool_unavailable");
    }
  });

  it("denies availability during scheduled runs", () => {
    const tool = new CronjobTool();
    const availability = tool.checkAvailability({
      ...createContext(),
      taskMetadata: {
        scheduleRunContext: {
          disallowScheduleManagement: true,
          runId: "run-1",
          scheduleId: "schedule-1"
        }
      }
    });

    expect(availability.available).toBe(false);
  });

  it("creates schedules and enqueues runs through the bound port", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cronjob-tool-"));
    const handle = createApplication(workspace, {
      config: { databasePath: join(workspace, "runtime.db") },
      provider: new CronjobProvider(),
      scheduler: { autoStart: false }
    });
    try {
      const tool = new CronjobTool();
      tool.bindPort({
        archiveSchedule: (scheduleId) => handle.service.archiveSchedule(scheduleId),
        createSchedule: (input) =>
          handle.service.createSchedule({
            ...input,
            providerName: handle.config.provider.name
          }),
        listSchedules: (query) => handle.service.listSchedules(query),
        pauseSchedule: (scheduleId) => handle.service.pauseSchedule(scheduleId),
        resumeSchedule: (scheduleId) => handle.service.resumeSchedule(scheduleId),
        runScheduleNow: (scheduleId) => handle.service.runScheduleNow(scheduleId),
        updateSchedule: (scheduleId, patch) => handle.service.updateSchedule(scheduleId, patch)
      });

      const createPrepared = tool.prepare({
        action: "create",
        every: "1m",
        name: "agent schedule",
        prompt: "run background work"
      });
      const createResult = await tool.execute(createPrepared.preparedInput, createContext());
      expect(createResult.success).toBe(true);
      if (!createResult.success) {
        return;
      }
      const scheduleId = String((createResult.output as Record<string, unknown>).scheduleId);
      expect(scheduleId.length).toBeGreaterThan(0);

      const runPrepared = tool.prepare({ action: "run", scheduleId });
      const runResult = await tool.execute(runPrepared.preparedInput, createContext());
      expect(runResult.success).toBe(true);

      await handle.service.tickScheduleOnce();
      const runs = handle.service.listScheduleRuns(scheduleId, { tail: 10 });
      expect(runs.some((run) => run.status === "completed")).toBe(true);
    } finally {
      handle.close();
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-1",
    userId: "local-user",
    workspaceRoot: process.cwd()
  };
}
