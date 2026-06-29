import { describe, expect, it } from "vitest";

import { ManualCompactCoordinator } from "../src/runtime/context/manual-compact-coordinator.js";

describe("ManualCompactCoordinator", () => {
  it("queues and consumes a manual compact request once", () => {
    const coordinator = new ManualCompactCoordinator();
    coordinator.request("task-1", "focus on bug list");
    expect(coordinator.consume("task-1")).toEqual({
      focusTopic: "focus on bug list",
      requestedAt: expect.any(String)
    });
    expect(coordinator.consume("task-1")).toBeNull();
  });
});
