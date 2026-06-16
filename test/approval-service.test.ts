import { describe, expect, it } from "vitest";

import { ApprovalService } from "../src/approvals/approval-service.js";
import { InMemoryApprovalRepository } from "./helpers/in-memory-approval-repository.js";

describe("approval service", () => {
  it("expires pending approvals after ttl", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const repository = new InMemoryApprovalRepository();
    const service = new ApprovalService(repository, {
      approvalTtlMs: 60_000,
      now: () => now
    });

    const request = service.ensureApprovalRequest({
      fingerprint: "fp-1",
      policyDecisionId: "policy-1",
      reason: "shell",
      requesterUserId: "user-1",
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "shell"
    });
    expect(request.approval.status).toBe("pending");

    now = new Date(now.getTime() + 120_000);
    const expired = service.findById(request.approval.approvalId);
    expect(expired?.status).toBe("timed_out");
  });

  it("records allow scope on resolution", () => {
    const repository = new InMemoryApprovalRepository();
    const service = new ApprovalService(repository, {
      approvalTtlMs: 300_000,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const { approval } = service.ensureApprovalRequest({
      fingerprint: "fp-2",
      policyDecisionId: "policy-2",
      reason: "write",
      requesterUserId: "user-1",
      taskId: "task-2",
      toolCallId: "call-2",
      toolName: "write_file"
    });

    const resolved = service.resolve({
      action: "allow",
      allowScope: "session",
      approvalId: approval.approvalId,
      reviewerId: "reviewer-1"
    });
    expect(resolved.allowScope).toBe("session");
  });
});
