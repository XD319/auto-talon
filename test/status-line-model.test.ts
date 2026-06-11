import { describe, expect, it } from "vitest";

import { DEFAULT_TUI_STATUS_LINE_CONFIG, resolveStatusLineFields, resolveTuiStatusLineConfig } from "../src/runtime/tui-status-line-config.js";
import {
  buildBuiltinStatusSegments,
  formatInteractionMode,
  formatModelShortName,
  formatTokensStatusField,
  mapRunStateLabel
} from "../src/tui/status-line-model.js";

describe("status line model", () => {
  const provider = {
    displayName: "Mock Provider",
    model: "claude-sonnet",
    name: "mock"
  } as const;

  it("resolves preset fields for each style", () => {
    expect(resolveStatusLineFields(resolveTuiStatusLineConfig({ style: "minimal" }))).toEqual({
      showBranch: false,
      showCost: false,
      showMode: false,
      showModel: true,
      showTokens: false
    });
    expect(resolveStatusLineFields(resolveTuiStatusLineConfig({ style: "standard" }))).toEqual({
      showBranch: true,
      showCost: false,
      showMode: true,
      showModel: true,
      showTokens: true
    });
    expect(resolveStatusLineFields(resolveTuiStatusLineConfig({ style: "detailed" }))).toEqual({
      showBranch: true,
      showCost: true,
      showMode: true,
      showModel: true,
      showTokens: true
    });
  });

  it("lets explicit show* override preset defaults", () => {
    const config = resolveTuiStatusLineConfig({ showCost: true, style: "minimal" });
    expect(resolveStatusLineFields(config).showCost).toBe(true);
    expect(resolveStatusLineFields(config).showModel).toBe(true);
    expect(resolveStatusLineFields(config).showMode).toBe(false);
  });

  it("formats interaction modes like Claude", () => {
    expect(formatInteractionMode("agent")).toBe("default");
    expect(formatInteractionMode("plan")).toBe("plan");
    expect(formatInteractionMode("acceptEdits")).toBe("accept-edits");
  });

  it("builds standard segment order model | mode | branch | tokens", () => {
    const segments = buildBuiltinStatusSegments({
      config: resolveTuiStatusLineConfig({ style: "standard" }),
      gitStatus: { branch: "main", dirty: true },
      inputLimit: 128_000,
      interactionMode: "plan",
      provider: provider as never,
      reservedOutput: 1_000,
      tokenHud: {
        compactedCount: 0,
        contextPercent: 34,
        estimatedCostUsd: 0,
        inputTokens: 12_000,
        microPrunedCount: 0
      }
    });

    expect(segments.map((segment) => segment.label)).toEqual([
      "claude-sonnet",
      "plan",
      "main*",
      "34% · 12k/127k"
    ]);
  });

  it("includes cost only in detailed preset", () => {
    const segments = buildBuiltinStatusSegments({
      config: resolveTuiStatusLineConfig({ style: "detailed" }),
      gitStatus: null,
      inputLimit: 8_000,
      interactionMode: "agent",
      provider: provider as never,
      reservedOutput: 500,
      tokenHud: {
        compactedCount: 0,
        contextPercent: 10,
        estimatedCostUsd: 0.0042,
        inputTokens: 0,
        microPrunedCount: 0
      }
    });

    expect(segments.at(-1)?.label).toBe("~$0.004");
  });

  it("formats model short name from provider metadata", () => {
    expect(formatModelShortName(provider as never)).toBe("claude-sonnet");
    expect(
      formatModelShortName({
        displayName: "Display",
        model: null,
        name: "mock"
      } as never)
    ).toBe("Display");
  });

  it("maps idle and running labels", () => {
    expect(mapRunStateLabel("idle")).toBe("ready");
    expect(mapRunStateLabel("running", "provider_status: indexing")).toBe("provider_status: indexing");
    expect(mapRunStateLabel("running", "running task")).toBe("running");
  });

  it("formats tokens with compaction suffix", () => {
    expect(
      formatTokensStatusField(42, 1200, 8000, 500, {
        compactedCount: 2,
        microPrunedCount: 1
      })
    ).toBe("42% · 1k/8k (micro-pruned: 1, compacted: 2)");
  });

  it("defaults to standard builtin config", () => {
    expect(DEFAULT_TUI_STATUS_LINE_CONFIG.style).toBe("standard");
    expect(DEFAULT_TUI_STATUS_LINE_CONFIG.type).toBe("builtin");
  });
});
