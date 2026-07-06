import { z } from "zod";

import type { ApprovalRuleStore } from "../../approvals/approval-rule-store.js";
import type { ApprovalService } from "../../approvals/approval-service.js";
import {
  mergeSessionApprovalFingerprintLists,
  readSessionApprovalFingerprints
} from "../../approvals/session-approval-fingerprints.js";
import type { AuditService } from "../../audit/audit-service.js";
import type { ApprovalAllowScope, ApprovalRecord, TaskRecord } from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { ExecutionKernel } from "../execution-kernel.js";
import type { ScheduleRunLifecycle } from "../scheduler/index.js";
import type {
  SaveSessionUiStateInput,
  SessionUiStateService
} from "../sessions/session-ui-state-service.js";
import { AppError, toAppError } from "../app-error.js";
import type { ApprovalActionResult } from "../application-service.js";

const approvalActionSchema = z.object({
  action: z.enum(["allow", "deny"]),
  allowScope: z.enum(["once", "session", "always"]).optional(),
  approvalId: z.string().min(1),
  reviewerId: z.string().min(1)
});

export interface ApprovalResolutionFacadeDependencies {
  approvalRuleStore: ApprovalRuleStore;
  approvalService: ApprovalService;
  auditService: AuditService;
  executionKernel: ExecutionKernel;
  findTask: (taskId: string) => TaskRecord | null;
  scheduleRunLifecycle: ScheduleRunLifecycle;
  sessionUiStateService: SessionUiStateService;
  traceService: TraceService;
  updateTask: (taskId: string, patch: { metadata?: TaskRecord["metadata"] }) => TaskRecord;
}

export interface ApprovalResolutionCallbacks {
  projectAssistantOutput: (sessionId: string | null, taskId: string, output: string | null) => void;
  releaseSessionLockIfTerminal: (task: TaskRecord) => void;
}

export class ApprovalResolutionFacade {
  private readonly approvalFailureContinuations = new Map<string, Promise<ApprovalActionResult>>();

  public constructor(
    private readonly dependencies: ApprovalResolutionFacadeDependencies,
    private readonly callbacks: ApprovalResolutionCallbacks
  ) {}

  public async resolveApproval(
    approvalId: string,
    action: "allow" | "deny",
    reviewerId: string,
    allowScope?: ApprovalAllowScope
  ): Promise<ApprovalActionResult> {
    const parsed = approvalActionSchema.parse({
      action,
      allowScope,
      approvalId,
      reviewerId
    });
    const existingApproval = this.dependencies.approvalService.findById(parsed.approvalId);
    if (existingApproval !== null && existingApproval.status !== "pending") {
      if (existingApproval.status === "denied" || existingApproval.status === "timed_out") {
        return this.resumeApprovalFailureOnce(existingApproval);
      }
      return this.toCompletedApprovalActionResult(existingApproval);
    }

    const approval = this.dependencies.approvalService.resolve({
      action: parsed.action,
      approvalId: parsed.approvalId,
      reviewerId: parsed.reviewerId,
      ...(parsed.allowScope !== undefined ? { allowScope: parsed.allowScope } : {})
    });
    if (approval.status === "approved" && approval.allowScope === "always") {
      this.dependencies.approvalRuleStore.addAlwaysRulesFromApproval(approval, reviewerId);
    }

    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "approval_resolved",
      payload: {
        approvalId: approval.approvalId,
        reviewerId: approval.reviewerId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName
      },
      stage: "governance",
      summary: `Approval ${approval.status} for ${approval.toolName}`,
      taskId: approval.taskId
    });
    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "review_resolved",
      payload: {
        approvalId: approval.approvalId,
        reviewerId: approval.reviewerId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName
      },
      stage: "lifecycle",
      summary: `Review resolved for ${approval.toolName}`,
      taskId: approval.taskId
    });

    this.dependencies.auditService.record({
      action: "approval_resolved",
      actor: `reviewer.${reviewerId}`,
      approvalId: approval.approvalId,
      outcome:
        approval.status === "approved"
          ? "approved"
          : approval.status === "timed_out"
            ? "timed_out"
            : "denied",
      payload: {
        allowScope: approval.allowScope,
        reviewerId,
        status: approval.status,
        toolName: approval.toolName
      },
      summary: `Approval ${approval.status} for ${approval.toolName}`,
      taskId: approval.taskId,
      toolCallId: approval.toolCallId
    });

    if (approval.status === "approved") {
      try {
        const taskBeforeResume = this.dependencies.findTask(approval.taskId);
        if (taskBeforeResume !== null) {
          this.dependencies.scheduleRunLifecycle.markResuming(taskBeforeResume);
        }
        if (approval.allowScope === "session" && approval.fingerprint !== null) {
          if (taskBeforeResume !== null) {
            this.dependencies.updateTask(approval.taskId, {
              metadata: {
                sessionApprovalFingerprints: mergeSessionApprovalFingerprintLists(
                  readSessionApprovalFingerprints(taskBeforeResume.metadata),
                  [approval.fingerprint]
                )
              }
            });
          }
          if (taskBeforeResume?.sessionId !== null && taskBeforeResume?.sessionId !== undefined) {
            this.persistSessionApprovalFingerprint(taskBeforeResume.sessionId, approval.fingerprint);
          }
        }
        const result = await this.dependencies.executionKernel.resumeTask(approval.taskId);
        this.dependencies.scheduleRunLifecycle.syncRunFromTask(result.task);
        this.callbacks.releaseSessionLockIfTerminal(result.task);
        this.callbacks.projectAssistantOutput(
          result.task.sessionId ?? null,
          result.task.taskId,
          result.output ?? null
        );
        return {
          approval,
          output: result.output,
          task: result.task
        };
      } catch (error) {
        const appError = toAppError(error);
        const task = this.dependencies.findTask(approval.taskId);
        if (task === null) {
          throw appError;
        }

        return {
          approval,
          error: appError,
          output: null,
          task
        };
      }
    }

    return this.resumeApprovalFailureOnce(approval);
  }

  public resumeApprovalFailureOnce(approval: ApprovalRecord): Promise<ApprovalActionResult> {
    const existing = this.approvalFailureContinuations.get(approval.approvalId);
    if (existing !== undefined) {
      return existing;
    }

    const continuation = this.resumeApprovalFailure(approval).finally(() => {
      this.approvalFailureContinuations.delete(approval.approvalId);
    });
    this.approvalFailureContinuations.set(approval.approvalId, continuation);
    return continuation;
  }

  private async resumeApprovalFailure(approval: ApprovalRecord): Promise<ApprovalActionResult> {
    const task = this.dependencies.findTask(approval.taskId);
    if (task === null || task.status !== "waiting_approval") {
      return this.toCompletedApprovalActionResult(approval);
    }

    try {
      const result = await this.dependencies.executionKernel.resumeTaskAfterApprovalFailure(
        approval.taskId,
        approval.toolCallId
      );
      this.dependencies.scheduleRunLifecycle.syncRunFromTask(result.task);
      this.callbacks.releaseSessionLockIfTerminal(result.task);
      this.callbacks.projectAssistantOutput(
        result.task.sessionId ?? null,
        result.task.taskId,
        result.output ?? null
      );
      return {
        approval,
        output: result.output,
        task: result.task
      };
    } catch (error) {
      const appError = toAppError(error);
      const currentTask = this.dependencies.findTask(approval.taskId);
      if (currentTask === null) {
        throw appError;
      }

      return {
        approval,
        error: appError,
        output: null,
        task: currentTask
      };
    }
  }

  private toCompletedApprovalActionResult(approval: ApprovalRecord): ApprovalActionResult {
    const task = this.dependencies.findTask(approval.taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${approval.taskId} was not found.`
      });
    }
    const result: ApprovalActionResult = {
      approval,
      output: task.finalOutput,
      task
    };
    if (task.errorCode !== null) {
      result.error = new AppError({
        code: task.errorCode,
        message: task.errorMessage ?? task.errorCode
      });
    }
    return result;
  }

  private persistSessionApprovalFingerprint(sessionId: string, fingerprint: string): void {
    const uiState = this.dependencies.sessionUiStateService.load(sessionId);
    if (uiState === null) {
      return;
    }
    if (uiState.sessionApprovalFingerprints.includes(fingerprint)) {
      return;
    }
    const saveInput: SaveSessionUiStateInput = {
      sessionApprovalFingerprints: [...uiState.sessionApprovalFingerprints, fingerprint],
      messages: uiState.messages,
      interactionMode: uiState.interactionMode
    };
    if (uiState.providerSelection !== null) {
      saveInput.providerSelection = uiState.providerSelection;
    }
    this.dependencies.sessionUiStateService.save(sessionId, saveInput);
  }
}
