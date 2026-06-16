import type { ApprovalDraft, ApprovalRecord, ApprovalRepository, ApprovalUpdatePatch } from "../src/types/index.js";

export class InMemoryApprovalRepository implements ApprovalRepository {
  private readonly records = new Map<string, ApprovalRecord>();

  public create(record: ApprovalDraft): ApprovalRecord {
    const created: ApprovalRecord = {
      allowScope: null,
      approvalId: record.approvalId,
      decidedAt: null,
      errorCode: null,
      expiresAt: record.expiresAt,
      fingerprint: record.fingerprint ?? null,
      policyDecisionId: record.policyDecisionId,
      reason: record.reason,
      requestedAt: record.requestedAt,
      requesterUserId: record.requesterUserId,
      reviewerId: null,
      reviewerNotes: null,
      status: "pending",
      taskId: record.taskId,
      toolCallId: record.toolCallId,
      toolName: record.toolName
    };
    this.records.set(created.approvalId, created);
    return created;
  }

  public findById(approvalId: string): ApprovalRecord | null {
    return this.records.get(approvalId) ?? null;
  }

  public findLatestByToolCall(taskId: string, toolCallId: string): ApprovalRecord | null {
    const matches = [...this.records.values()].filter(
      (record) => record.taskId === taskId && record.toolCallId === toolCallId
    );
    return matches.at(-1) ?? null;
  }

  public listByTaskId(taskId: string): ApprovalRecord[] {
    return [...this.records.values()].filter((record) => record.taskId === taskId);
  }

  public listPending(): ApprovalRecord[] {
    return [...this.records.values()].filter((record) => record.status === "pending");
  }

  public update(approvalId: string, patch: ApprovalUpdatePatch): ApprovalRecord {
    const existing = this.records.get(approvalId);
    if (existing === undefined) {
      throw new Error(`Approval ${approvalId} not found`);
    }
    const updated: ApprovalRecord = {
      ...existing,
      ...patch,
      allowScope: patch.allowScope === undefined ? existing.allowScope : patch.allowScope,
      decidedAt: patch.decidedAt === undefined ? existing.decidedAt : patch.decidedAt,
      errorCode: patch.errorCode === undefined ? existing.errorCode : patch.errorCode,
      reviewerId: patch.reviewerId === undefined ? existing.reviewerId : patch.reviewerId,
      reviewerNotes: patch.reviewerNotes === undefined ? existing.reviewerNotes : patch.reviewerNotes,
      status: patch.status === undefined ? existing.status : patch.status
    };
    this.records.set(approvalId, updated);
    return updated;
  }
}
