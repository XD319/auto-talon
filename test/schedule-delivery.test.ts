import { describe, expect, it } from "vitest";

import {
  readScheduleDeliveryTargets,
  resolveDefaultDeliveryTargets,
  shouldDeliverToInbox,
  shouldDeliverToOrigin,
  shouldDeliverViaWebhook
} from "../src/runtime/scheduler/schedule-delivery.js";
import type { ScheduleRecord } from "../src/types/index.js";

describe("schedule delivery helpers", () => {
  it("defaults to inbox only without origin metadata", () => {
    expect(resolveDefaultDeliveryTargets({})).toEqual(["inbox"]);
  });

  it("appends origin when gateway metadata includes origin", () => {
    expect(
      resolveDefaultDeliveryTargets({
        origin: { adapter: "feishu-im", chatId: "chat-1" }
      })
    ).toEqual(["inbox", "origin"]);
  });

  it("honors explicit delivery targets on schedules", () => {
    const schedule = createSchedule({
      metadata: {
        delivery: {
          targets: ["origin", "webhook"],
          webhookUrl: "https://example.com/hook"
        },
        origin: { adapter: "feishu-im", chatId: "chat-1" }
      }
    });

    expect(readScheduleDeliveryTargets(schedule)).toEqual(["origin", "webhook"]);
    expect(shouldDeliverToInbox(schedule)).toBe(false);
    expect(shouldDeliverToOrigin(schedule)).toBe(true);
    expect(shouldDeliverViaWebhook(schedule)).toBe(true);
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
    intervalMs: null,
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
