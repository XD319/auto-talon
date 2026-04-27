import { describe, expect, it } from "vitest";

import { summarizeDiffLines } from "../src/tui/panels/diff-panel.js";
import { sanitizeTerminalText } from "../src/tui/text-sanitize.js";

describe("tui sanitization and diff helpers", () => {
  it("strips OSC terminal sequences terminated by BEL", () => {
    const input = "hello \u001b]8;;https://example.com\u0007link\u001b]8;;\u0007 world";
    expect(sanitizeTerminalText(input)).toBe("hello link world");
  });

  it("strips OSC terminal sequences terminated by ST", () => {
    const input = "before \u001b]0;window title\u001b\\ after";
    expect(sanitizeTerminalText(input)).toBe("before  after");
  });

  it("keeps first 40 diff lines and reports truncation count", () => {
    const unifiedDiff = Array.from({ length: 45 }, (_, index) => `line-${index + 1}`).join("\n");
    const result = summarizeDiffLines(unifiedDiff);
    expect(result.visibleLines).toHaveLength(40);
    expect(result.visibleLines[0]).toBe("line-1");
    expect(result.visibleLines.at(-1)).toBe("line-40");
    expect(result.hiddenLineCount).toBe(5);
  });
});
