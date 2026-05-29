import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[2J\u001b[H";
const EXIT_ALT_SCREEN = "\u001b[?1049l";

describe("chat tui terminal screen", () => {
  let originalIsTty: boolean | undefined;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createApplication.mockClear();
    closeApplication.mockClear();
    render.mockClear();
    waitUntilExit.mockClear();
    unmount.mockClear();
    originalIsTty = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true
    });
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalIsTty
    });
  });

  it("runs the chat tui inside the alternate terminal screen", async () => {
    await startTui({ cwd: "D:\\workspace" });

    const writes = writeSpy.mock.calls.map((call) => String(call[0]));
    expect(writes[0]).toBe(ENTER_ALT_SCREEN);
    expect(writes.at(-1)).toBe(EXIT_ALT_SCREEN);
    expect(render).toHaveBeenCalledTimes(1);
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(closeApplication).toHaveBeenCalledTimes(1);
  });
});
