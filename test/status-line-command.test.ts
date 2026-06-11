import { describe, expect, it } from "vitest";

import { resolveTuiStatusLineConfig } from "../src/runtime/tui-status-line-config.js";
import {
  buildStatusLinePayload,
  resetStatusLineCommandThrottle,
  runStatusLineCommand
} from "../src/tui/status-line-command.js";

describe("status line command", () => {
  it("builds a Claude-compatible payload subset", () => {
    const payload = buildStatusLinePayload({
      cwd: "/workspace",
      gitStatus: { branch: "main", dirty: false },
      inputLimit: 128_000,
      interactionMode: "agent",
      provider: {
        displayName: "Mock Provider",
        model: "mock-model",
        name: "mock"
      } as never,
      renderWidthChars: 120,
      reservedOutput: 1_000,
      runState: "idle",
      sessionId: "session-1",
      tokenHud: {
        contextPercent: 12,
        estimatedCostUsd: 0.01,
        inputTokens: 1500
      }
    });

    expect(payload.session_id).toBe("session-1");
    expect(payload.model).toEqual({ display_name: "mock-model", id: "mock-model" });
    expect(payload.workspace).toEqual({
      current_dir: "/workspace",
      git_branch: "main",
      git_dirty: false
    });
    expect(payload.context_window.used_percentage).toBe(12);
    expect(payload.cost.total_cost_usd).toBe(0.01);
  });

  it("rejects missing command configuration", async () => {
    resetStatusLineCommandThrottle();
    const result = await runStatusLineCommand(
      resolveTuiStatusLineConfig({ command: null, type: "command" }),
      buildStatusLinePayload({
        cwd: "/workspace",
        gitStatus: null,
        inputLimit: 8_000,
        interactionMode: "agent",
        provider: { displayName: "Mock", model: "mock", name: "mock" } as never,
        renderWidthChars: 80,
        reservedOutput: 500,
        runState: "idle",
        sessionId: null,
        tokenHud: { contextPercent: 0, estimatedCostUsd: 0, inputTokens: 0 }
      })
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not configured");
  });

  it("runs an inline command and returns stdout", async () => {
    resetStatusLineCommandThrottle();
    const payload = buildStatusLinePayload({
      cwd: "/workspace",
      gitStatus: null,
      inputLimit: 8_000,
      interactionMode: "agent",
      provider: { displayName: "Mock", model: "mock", name: "mock" } as never,
      renderWidthChars: 80,
      reservedOutput: 500,
      runState: "idle",
      sessionId: null,
      tokenHud: { contextPercent: 0, estimatedCostUsd: 0, inputTokens: 0 }
    });
    const command = `${process.execPath} -e "console.log('custom status')"`;

    const result = await runStatusLineCommand(
      resolveTuiStatusLineConfig({ command, type: "command", updateIntervalMs: 300 }),
      payload
    );

    expect(result.ok).toBe(true);
    expect(result.text).toBe("custom status");
  }, 10_000);
});
