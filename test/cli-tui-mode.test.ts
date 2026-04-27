import { describe, expect, it, vi, beforeEach } from "vitest";

const { startDashboardTui, startTui } = vi.hoisted(() => ({
  startDashboardTui: vi.fn(async () => {}),
  startTui: vi.fn(async () => {})
}));

vi.mock("../src/tui/index.js", () => ({
  startDashboardTui,
  startTui
}));

import { main } from "../src/cli/index.js";

describe("cli tui mode routing", () => {
  beforeEach(() => {
    startDashboardTui.mockClear();
    startTui.mockClear();
  });

  it("routes talon ops to dashboard tui", async () => {
    await main(["node", "talon", "ops"]);
    expect(startDashboardTui).toHaveBeenCalledTimes(1);
    expect(startTui).not.toHaveBeenCalled();
  });

  it("routes talon tui --mode ops to dashboard tui", async () => {
    await main(["node", "talon", "tui", "--mode", "ops"]);
    expect(startDashboardTui).toHaveBeenCalledTimes(1);
    expect(startTui).not.toHaveBeenCalled();
  });

  it("keeps dashboard mode alias compatibility", async () => {
    await main(["node", "talon", "tui", "--mode", "dashboard"]);
    expect(startDashboardTui).toHaveBeenCalledTimes(1);
    expect(startTui).not.toHaveBeenCalled();
  });
});
