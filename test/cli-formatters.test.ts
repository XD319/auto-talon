import { describe, expect, it } from "vitest";

import { formatApprovalList } from "../src/cli/formatters.js";

describe("cli formatters", () => {
  it("formats invalid approval expiry as unknown", () => {
    const output = formatApprovalList([
      {
        approvalId: "approval-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "not-a-date",
        reason: "test approval",
        reviewerId: null,
        status: "pending",
        taskId: "task-1",
        toolCallId: "tool-1",
        toolName: "shell"
      }
    ]);

    expect(output).toContain("expires=unknown");
  });
});
