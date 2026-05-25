import { afterEach, describe, expect, it, vi } from "vitest";

import { createManagedAbortController } from "../src/runtime/abort-controller.js";

describe("createManagedAbortController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses wall-clock timeout by default", () => {
    vi.useFakeTimers();
    const controller = createManagedAbortController(100);

    controller.touchActivity("still working");
    vi.advanceTimersByTime(100);

    expect(controller.abortController.signal.aborted).toBe(true);
    expect(controller.getReason()).toBe("timeout");
    controller.dispose();
  });

  it("resets activity timeout when touched", () => {
    vi.useFakeTimers();
    const controller = createManagedAbortController(100, undefined, { mode: "activity" });

    vi.advanceTimersByTime(75);
    controller.touchActivity("assistant_turn_delta");
    vi.advanceTimersByTime(75);
    expect(controller.abortController.signal.aborted).toBe(false);

    vi.advanceTimersByTime(25);
    expect(controller.abortController.signal.aborted).toBe(true);
    expect(controller.getLastActivityReason()).toBe("assistant_turn_delta");
    expect(controller.getReason()).toBe("timeout");
    controller.dispose();
  });

  it("emits one inactivity warning per quiet window", () => {
    vi.useFakeTimers();
    const warnings: string[] = [];
    const controller = createManagedAbortController(100, undefined, {
      mode: "activity",
      onInactivityWarning: (details) => warnings.push(details.lastActivityReason ?? "none")
    });

    controller.touchActivity("provider_request_started");
    vi.advanceTimersByTime(75);
    vi.advanceTimersByTime(10);
    expect(warnings).toEqual(["provider_request_started"]);

    vi.advanceTimersByTime(5);
    expect(warnings).toEqual(["provider_request_started"]);
    controller.dispose();
  });
});
