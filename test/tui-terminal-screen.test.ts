import { describe, expect, it, vi } from "vitest";

const { closeApplication, createApplication, render, unmount, waitUntilExit } = vi.hoisted(() => {
  const closeApplication = vi.fn();
  const waitUntilExit = vi.fn(() => Promise.resolve());
  const unmount = vi.fn();
  const render = vi.fn(() => ({ unmount, waitUntilExit }));
  const createApplication = vi.fn(() => ({
    close: closeApplication,
    config: {
      provider: { name: "mock" },
      workspaceRoot: "D:\\workspace"
    },
    service: {}
  }));
  return { closeApplication, createApplication, render, unmount, waitUntilExit };
});

vi.mock("ink", () => ({
  render
}));

vi.mock("../src/runtime/index.js", () => ({
  createApplication
}));

vi.mock("../src/tui/chat-app.js", () => ({
  ChatTuiApp: () => null
}));

vi.mock("../src/tui/dashboard-app.js", () => ({
  AgentTuiApp: () => null
}));

vi.mock("../src/tui/session-store.js", () => ({
  loadSession: vi.fn(() => Promise.resolve(null))
}));

vi.mock("../src/tui/view-models/runtime-dashboard.js", () => ({
  RuntimeDashboardQueryService: class RuntimeDashboardQueryService {}
}));

import { startTui } from "../src/tui/index.js";

describe("chat tui terminal screen", () => {
  it("renders with alternateScreen enabled via ink", async () => {
    render.mockClear();
    waitUntilExit.mockClear();
    unmount.mockClear();
    closeApplication.mockClear();

    await startTui({ cwd: "D:\\workspace" });

    expect(render).toHaveBeenCalledTimes(1);
    const renderOptions = render.mock.calls[0]?.[1];
    expect(renderOptions).toMatchObject({
      alternateScreen: true,
      exitOnCtrlC: false
    });
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });
});
