import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectFeatureBacklog,
  extractFeatureBacklogFromDecisions,
  extractFeatureBacklogFromText,
  formatFeatureBacklogForResume,
  formatFeatureBacklogSection,
  fromTodoItems,
  isLikelyFeatureName,
  mergeFeatureBacklog,
  parseFeatureBacklogFromMetadata,
  sanitizeFeatureBacklogForResume
} from "../src/runtime/sessions/session-feature-backlog.js";

const talonTestFixture = readFileSync(
  join(import.meta.dirname, "fixtures/talon-test-feature-backlog.txt"),
  "utf8"
);

describe("session feature backlog", () => {
  it("extracts feature rows from markdown tables", () => {
    const text = [
      "| 功能 | 复杂度 | 说明 |",
      "|------|--------|------|",
      "| ✅ 皮肤选择 | 中等 | 已完成 |",
      "| 排行榜 | 中等 | 待实现 |"
    ].join("\n");
    const items = extractFeatureBacklogFromText(text);
    expect(items).toEqual([
      { name: "皮肤选择", source: "agent", status: "done" },
      { name: "排行榜", source: "agent", status: "pending" }
    ]);
  });

  it("extracts task rows and ignores metric and file tables from talon-test fixture", () => {
    const items = extractFeatureBacklogFromText(talonTestFixture);
    expect(items.map((item) => item.name)).toEqual([
      "删除 js/renderer.js",
      "删除 js/particles.js",
      "更新测试文件",
      "验证测试",
      "集成 GameState",
      "添加更多测试"
    ]);
    expect(items.filter((item) => item.status === "done").map((item) => item.name)).toEqual([
      "删除 js/renderer.js",
      "删除 js/particles.js",
      "更新测试文件",
      "验证测试"
    ]);
    expect(items.some((item) => item.name.includes("this.config"))).toBe(false);
    expect(items.some((item) => item.name.includes("🔴"))).toBe(false);
    expect(items.some((item) => item.name.includes("BaseRenderer"))).toBe(false);
    expect(items.some((item) => item.name.includes("JS 文件数量"))).toBe(false);
  });

  it("ignores code blocks and code-like table rows", () => {
    const text = [
      "```js",
      "this.config = config | this.logLevel = options.logLevel",
      "```",
      "| 任务 | 状态 |",
      "|------|------|",
      "| this.config = config | pending |"
    ].join("\n");
    expect(extractFeatureBacklogFromText(text)).toEqual([]);
  });

  it("merges backlog status without dropping prior items", () => {
    const merged = mergeFeatureBacklog(
      [{ name: "皮肤选择", source: "agent", status: "pending" }],
      [{ name: "皮肤选择", source: "agent", status: "done" }, { name: "音效系统", source: "agent", status: "pending" }]
    );
    expect(merged).toEqual([
      { name: "皮肤选择", source: "agent", status: "done" },
      { name: "音效系统", source: "agent", status: "pending" }
    ]);
  });

  it("collects clarify decisions and session todos with higher trust", () => {
    const result = collectFeatureBacklog({
      assistantMessages: [],
      decisions: ["Clarify: 皮肤选择"],
      sessionTodos: [
        { content: "实现音效系统", id: "todo-1", status: "pending" },
        { content: "旧任务", id: "todo-2", status: "cancelled" }
      ]
    });
    expect(result.items).toEqual([
      { name: "皮肤选择", source: "clarify", status: "pending" },
      { name: "实现音效系统", source: "agent", status: "pending" }
    ]);
    expect(result.rawCount).toBe(2);
    expect(result.droppedCount).toBe(0);
  });

  it("filters noisy metadata items during collection", () => {
    const result = collectFeatureBacklog({
      assistantMessages: [
        [
          "| 任务 | 状态 |",
          "|------|------|",
          "| 删除 js/renderer.js | ✅ 完成 |",
          "| 🔴 高 | pending |"
        ].join("\n")
      ],
      previousMetadata: {
        featureBacklog: [{ name: "this.config = config", source: "agent", status: "pending" }]
      }
    });
    expect(result.rawCount).toBe(2);
    expect(result.filteredCount).toBe(1);
    expect(result.items).toEqual([{ name: "删除 js/renderer.js", source: "agent", status: "done" }]);
  });

  it("round-trips through metadata and formats resume section", () => {
    const metadata = {
      featureBacklog: [{ name: "排行榜", source: "agent", status: "pending" }]
    };
    const parsed = parseFeatureBacklogFromMetadata(metadata);
    expect(formatFeatureBacklogSection(parsed)).toContain("[pending] 排行榜");
  });

  it("formats resume backlog with pending and done sections", () => {
    const formatted = formatFeatureBacklogForResume([
      { name: "集成 GameState", source: "agent", status: "pending" },
      { name: "删除 js/renderer.js", source: "agent", status: "done" }
    ]);
    expect(formatted).toContain("Pending:");
    expect(formatted).toContain("- 集成 GameState");
    expect(formatted).toContain("Done (recent):");
    expect(formatted).toContain("- [done] 删除 js/renderer.js");
  });

  it("does not resume inject when sanitized backlog is too small", () => {
    const sanitized = sanitizeFeatureBacklogForResume([
      { name: "this.config = config", source: "agent", status: "pending" }
    ]);
    expect(sanitized).toEqual([]);
    expect(formatFeatureBacklogForResume(sanitized)).toBe("");
  });

  it("accepts action-oriented and Chinese feature names", () => {
    expect(isLikelyFeatureName("删除 js/renderer.js")).toBe(true);
    expect(isLikelyFeatureName("皮肤选择")).toBe(true);
    expect(isLikelyFeatureName("this.config = config")).toBe(false);
    expect(isLikelyFeatureName("🔴 高")).toBe(false);
    expect(isLikelyFeatureName("js/renderer/BaseRenderer.js")).toBe(false);
  });

  it("extracts clarify decisions into backlog items", () => {
    expect(extractFeatureBacklogFromDecisions(["Clarify: 排行榜"])).toEqual([
      { name: "排行榜", source: "clarify", status: "pending" }
    ]);
  });

  it("maps todo items into backlog entries", () => {
    expect(
      fromTodoItems([{ content: "实现排行榜", id: "todo-1", status: "completed" }])
    ).toEqual([{ name: "实现排行榜", source: "agent", status: "done" }]);
  });
});
