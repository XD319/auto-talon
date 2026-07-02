import { describe, expect, it } from "vitest";

import {
  cycleInteractionMode,
  formatAgentWriteApprovalHelp,
  formatModeChangeMessage
} from "../src/tui/interaction-mode.js";

describe("interaction mode helpers", () => {
  it("cycles agent -> plan -> acceptEdits -> agent", () => {
    expect(cycleInteractionMode("agent")).toBe("plan");
    expect(cycleInteractionMode("plan")).toBe("acceptEdits");
    expect(cycleInteractionMode("acceptEdits")).toBe("agent");
  });

  it("formats mode change messages", () => {
    expect(formatModeChangeMessage("plan")).toContain("read-only");
    expect(formatModeChangeMessage("acceptEdits")).toContain("acceptEdits");
    expect(formatModeChangeMessage("agent")).toContain("agent");
  });

  it("formats agent write approval help", () => {
    expect(formatAgentWriteApprovalHelp("off")).toContain("do not require approval");
    expect(formatAgentWriteApprovalHelp("on")).toContain("require approval");
    expect(formatAgentWriteApprovalHelp("acceptEditsOnly")).toContain("acceptEdits");
  });
});
