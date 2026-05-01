import { describe, expect, it, vi } from "vitest";

import {
  parseNaturalLanguageScheduleIntent,
  parseNaturalLanguageScheduleWhen
} from "../src/runtime/scheduler/natural-language-schedule.js";

describe("natural language schedule parser", () => {
  it("parses recurring chinese phrases", () => {
    expect(parseNaturalLanguageScheduleWhen("每小时")).toEqual({ every: "1h" });
    expect(parseNaturalLanguageScheduleWhen("每天")).toEqual({ every: "1d" });
    expect(parseNaturalLanguageScheduleWhen("每周")).toEqual({ every: "7d" });
  });

  it("parses relative duration phrases", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 28, 9, 15, 0, 0));
    expect(parseNaturalLanguageScheduleWhen("一分钟后").runAt).toBe(
      new Date(2026, 3, 28, 9, 16, 0, 0).toISOString()
    );
    expect(parseNaturalLanguageScheduleWhen("1分钟后").runAt).toBe(
      new Date(2026, 3, 28, 9, 16, 0, 0).toISOString()
    );
    expect(parseNaturalLanguageScheduleWhen("2小时后").runAt).toBe(
      new Date(2026, 3, 28, 11, 15, 0, 0).toISOString()
    );
    vi.useRealTimers();
  });

  it("parses relative local day phrases", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 28, 9, 15, 0, 0));
    expect(parseNaturalLanguageScheduleWhen("今天 18:30").runAt).toBe(
      new Date(2026, 3, 28, 18, 30, 0, 0).toISOString()
    );
    expect(parseNaturalLanguageScheduleWhen("明天 08:05").runAt).toBe(
      new Date(2026, 3, 29, 8, 5, 0, 0).toISOString()
    );
    vi.useRealTimers();
  });

  it("parses daily time phrases as cron", () => {
    expect(parseNaturalLanguageScheduleWhen("每天 18:00")).toEqual({ cron: "0 18 * * *" });
    expect(parseNaturalLanguageScheduleWhen("每天18点")).toEqual({ cron: "0 18 * * *" });
  });

  it("parses absolute local date phrases", () => {
    expect(parseNaturalLanguageScheduleWhen("2026-05-01 09:45").runAt).toBe(
      new Date(2026, 4, 1, 9, 45, 0, 0).toISOString()
    );
    expect(parseNaturalLanguageScheduleWhen("2026-05-01T21:10").runAt).toBe(
      new Date(2026, 4, 1, 21, 10, 0, 0).toISOString()
    );
  });

  it("extracts schedule intent from natural language messages", () => {
    const parsed = parseNaturalLanguageScheduleIntent("一分钟后提醒我测试");
    expect(parsed?.whenText).toBe("一分钟后");
    expect(parsed?.taskInput).toBe("测试");

    const daily = parseNaturalLanguageScheduleIntent("每天18点帮我执行复盘");
    expect(daily?.schedule).toEqual({ cron: "0 18 * * *" });
    expect(daily?.taskInput).toBe("复盘");
  });

  it("rejects unsupported or invalid phrases", () => {
    expect(() => parseNaturalLanguageScheduleWhen("每月")).toThrow(/Unsupported schedule phrase/u);
    expect(() => parseNaturalLanguageScheduleWhen("2026-02-31 09:00")).toThrow(/invalid/u);
  });
});
