import { describe, expect, it } from "vitest";

import { formatTodayLine } from "../web/src/i18n";
import { matchingSlashCommands, parseSlashIntent } from "../web/src/slash";

describe("web slash intents", () => {
  it("parses /clear with an optional title", () => {
    expect(parseSlashIntent("/clear")).toEqual({ kind: "clear" });
    expect(parseSlashIntent("/clear Saved chat")).toEqual({ kind: "clear", title: "Saved chat" });
    expect(parseSlashIntent("/new")).toEqual({ kind: "new" });
  });

  it("parses today, memory, and mode commands", () => {
    expect(parseSlashIntent("/today")).toEqual({ kind: "today" });
    expect(parseSlashIntent("/memory")).toEqual({ kind: "memory" });
    expect(parseSlashIntent("/mode plan")).toEqual({ kind: "mode", mode: "plan" });
  });

  it("filters slash hints from a draft prefix", () => {
    expect(matchingSlashCommands("/to").some((item) => item.insert === "/today")).toBe(true);
    expect(matchingSlashCommands("hello")).toEqual([]);
  });
});

describe("today summary line", () => {
  it("includes inbox and running task counts", () => {
    expect(formatTodayLine("en", 3, 1, "$0.012")).toBe("3 inbox · 1 Tasks · $0.012");
    expect(formatTodayLine("zh-CN", 0, 2, null)).toContain("2");
  });
});
