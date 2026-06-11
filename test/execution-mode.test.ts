import { describe, expect, it } from "vitest";

import {
  parseExecutionModeInput,
  resolveCreateScheduleSessionId,
  resolveScheduleSessionId
} from "../src/runtime/scheduler/execution-mode.js";
import type { ScheduleRecord } from "../src/types/index.js";

describe("execution mode", () => {
  it("parses session mode prefixes", () => {
    expect(parseExecutionModeInput("session:abc-123")).toEqual({
      executionMode: "session",
      sessionId: "abc-123"
    });
  });

  it("forces isolated runs to ignore stored session ids", () => {
    const schedule = createSchedule({
      metadata: { executionMode: "isolated" },
      sessionId: "session-1"
    });
    expect(resolveScheduleSessionId(schedule)).toBeNull();
  });

  it("keeps continue mode session ids", () => {
    const schedule = createSchedule({
      metadata: { executionMode: "continue" },
      sessionId: "session-1"
    });
    expect(resolveScheduleSessionId(schedule)).toBe("session-1");
    expect(
      resolveCreateScheduleSessionId({
        continuationSessionId: "session-2",
        executionMode: "continue"
      })
    ).toBe("session-2");
  });
});

function createSchedule(overrides: Partial<ScheduleRecord>): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    cron: null,
    cwd: process.cwd(),
    input: "task",
    intervalMs: 60_000,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: {},
    name: "test",
    nextFireAt: null,
    ownerUserId: "local-user",
    providerName: "mock",
    runAt: null,
    scheduleId: "schedule-1",
    sessionId: null,
    status: "active",
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
