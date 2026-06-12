import { describe, expect, it } from "vitest";

import {
  previewScheduleTiming,
  resolveScheduleTiming,
  timingToCreateFields
} from "../src/runtime/scheduler/schedule-timing.js";

describe("schedule timing", () => {
  it("normalizes supported timing modes", () => {
    expect(timingToCreateFields(resolveScheduleTiming({ every: "5m" }))).toEqual({ every: "5m" });
    expect(timingToCreateFields(resolveScheduleTiming({ cron: "0 8 * * *", timezone: "UTC" }))).toEqual({
      cron: "0 8 * * *",
      timezone: "UTC"
    });
    expect(timingToCreateFields(resolveScheduleTiming({ at: "30m" })).runAt).toBeTruthy();
  });

  it("rejects ambiguous timing", () => {
    expect(() => resolveScheduleTiming({ cron: "0 8 * * *", every: "1h" })).toThrow(/exactly one/u);
    expect(() => resolveScheduleTiming({ when: "every 1h", every: "1h" })).toThrow(/cannot combine/u);
  });

  it("previews cron fires", () => {
    const preview = previewScheduleTiming(
      resolveScheduleTiming({ cron: "*/15 * * * *", timezone: "UTC" }),
      3,
      new Date("2026-01-01T00:00:00.000Z")
    );
    expect(preview.nextFirePreview).toEqual([
      "2026-01-01T00:15:00.000Z",
      "2026-01-01T00:30:00.000Z",
      "2026-01-01T00:45:00.000Z"
    ]);
  });
});
