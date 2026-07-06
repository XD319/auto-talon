import { describe, expect, it } from "vitest";

import { ManualCompactCoordinator } from "../src/runtime/context/manual-compact-coordinator.js";

describe("ManualCompactCoordinator", () => {
  it("queues and consumes a manual compact request once", () => {
    const coordinator = new ManualCompactCoordinator();
    coordinator.request("task-1", "focus on bug list");
    const request = coordinator.consume("task-1");
    expect(request?.focusTopic).toBe("focus on bug list");
    expect(typeof request?.requestedAt).toBe("string");
    expect(coordinator.consume("task-1")).toBeNull();
  });
});
