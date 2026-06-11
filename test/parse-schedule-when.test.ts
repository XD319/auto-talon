import { describe, expect, it } from "vitest";

import { parseScheduleWhen } from "../src/runtime/scheduler/parse-schedule-when.js";

describe("parseScheduleWhen", () => {
  const now = new Date("2026-06-11T10:00:00.000Z");

  it("parses relative one-shot delays", () => {
    expect(parseScheduleWhen("30m", now)).toEqual({
      runAt: "2026-06-11T10:30:00.000Z"
    });
  });

  it("parses every intervals", () => {
    expect(parseScheduleWhen("every 2h", now)).toEqual({ every: "2h" });
  });

  it("parses cron expressions", () => {
    expect(parseScheduleWhen("0 8 * * *", now)).toEqual({ cron: "0 8 * * *" });
  });
});
