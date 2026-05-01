import type { InboxService } from "./inbox-service.js";
import type {
  NextActionRecord,
  ScheduleRecord,
  ScheduleRunRecord,
  TaskRecord,
  TraceEvent,
  JsonObject
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { NextActionService } from "../commitments/index.js";

export interface InboxCollectorDependencies {
  findSchedule: (scheduleId: string) => ScheduleRecord | null;
  findTask: (taskId: string) => TaskRecord | null;
  inboxService: InboxService;
  listScheduleRunsByTask: (taskId: string) => ScheduleRunRecord[];
  nextActionService: NextActionService;
  traceService: TraceService;
}

export class InboxCollector {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly dependencies: InboxCollectorDependencies) {}

  public start(): void {
    if (this.unsubscribe !== null) {
      return;
    }
    this.unsubscribe = this.dependencies.traceService.subscribe((event: TraceEvent) => {
      this.handleTrace(event);
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private handleTrace(event: TraceEvent): void {
    switch (event.eventType) {
      case "task_success":
        if (this.findRelatedScheduleRun(event.taskId) !== null) {
          return;
        }
        this.dependencies.inboxService.append({
          category: "task_completed",
          dedupKey: `task_success:${event.taskId}`,
          severity: "info",
          sourceTraceId: event.eventId,
          summary: event.payload.outputSummary,
          taskId: event.taskId,
          threadId: this.dependencies.findTask(event.taskId)?.threadId ?? null,
          title: "Task completed",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "task_failure":
        if (this.findRelatedScheduleRun(event.taskId) !== null) {
          return;
        }
        this.dependencies.inboxService.append({
          category: "task_failed",
          dedupKey: `task_failure:${event.taskId}`,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: `${event.payload.errorCode}: ${event.payload.errorMessage}`,
          taskId: event.taskId,
          threadId: this.dependencies.findTask(event.taskId)?.threadId ?? null,
          title: "Task failed",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "approval_requested":
        {
          const scheduleRun = this.findRelatedScheduleRun(event.taskId);
          const schedule = scheduleRun === null ? null : this.dependencies.findSchedule(scheduleRun.scheduleId);
          this.dependencies.inboxService.append({
            actionHint: "talon approve resolve <approval-id> --action allow --reviewer <user>",
            category: "approval_requested",
            dedupKey: `approval_requested:${event.payload.approvalId}`,
            metadata: buildApprovalInboxMetadata(schedule, event.payload.approvalId),
            scheduleRunId: scheduleRun?.runId ?? null,
            severity: "action_required",
            sourceTraceId: event.eventId,
            summary: `${event.payload.toolName} requires approval`,
            taskId: event.taskId,
            threadId: this.dependencies.findTask(event.taskId)?.threadId ?? null,
            title: "Approval requested",
            userId: this.resolveUserId(event.taskId)
          });
        }
        return;
      case "approval_resolved": {
        const pending = this.dependencies.inboxService
          .list({ status: "pending", taskId: event.taskId })
          .find((item) => item.dedupKey === `approval_requested:${event.payload.approvalId}`);
        if (pending !== undefined) {
          this.dependencies.inboxService.markDone(
            pending.inboxId,
            event.payload.reviewerId ?? "system-reviewer"
          );
        }
        return;
      }
      case "experience_promoted":
        if (event.payload.target === "project_memory" || event.payload.target === "profile_memory") {
          this.dependencies.inboxService.append({
            actionHint: "talon memory review-queue accept <inbox-id> | talon memory review-queue dismiss <inbox-id>",
            category: "memory_suggestion",
            dedupKey: `memory_suggestion:${event.payload.experienceId}`,
            experienceId: event.payload.experienceId,
            metadata: {
              promotedMemoryId: event.payload.promotedMemoryId,
              target: event.payload.target
            },
            severity: "action_required",
            sourceTraceId: event.eventId,
            summary: `A ${event.payload.target === "project_memory" ? "project" : "profile"} memory suggestion is ready for review.`,
            taskId: event.taskId,
            title: "Memory suggestion",
            userId: this.resolveUserId(event.taskId)
          });
        }
        if (event.payload.target === "skill_candidate") {
          this.dependencies.inboxService.append({
            category: "skill_promotion",
            dedupKey: `skill_promotion:${event.payload.experienceId}`,
            experienceId: event.payload.experienceId,
            severity: "info",
            sourceTraceId: event.eventId,
            summary: "A new skill candidate is ready for promotion.",
            taskId: event.taskId,
            title: "Skill promotion suggestion",
            userId: this.resolveUserId(event.taskId)
          });
        }
        return;
      case "skill_promotion_suggested":
        this.dependencies.inboxService.append({
          actionHint:
            `talon skill approve ${event.payload.draftId} | ` +
            `talon skill reject ${event.payload.draftId} | ` +
            `talon skill rollback ${event.payload.targetSkillId} --reason "<text>"`,
          category: "skill_promotion",
          dedupKey: `skill_promotion_suggested:${event.payload.draftId}`,
          severity: "action_required",
          sourceTraceId: event.eventId,
          summary: `Suggested promotion for ${event.payload.targetSkillId} (${event.payload.version})`,
          taskId: event.taskId,
          title: "Skill promotion requires review",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "budget_warning":
        this.dependencies.inboxService.append({
          category: "budget_warning",
          dedupKey: `budget_warning:${event.taskId}:${event.payload.scope}`,
          severity: "info",
          sourceTraceId: event.eventId,
          summary: event.payload.reasons.join("; "),
          taskId: event.taskId,
          threadId: event.payload.threadId,
          title: "Budget warning",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "budget_exceeded":
        this.dependencies.inboxService.append({
          actionHint: `talon budget show --task ${event.taskId} | talon budget raise --task ${event.taskId} --hard-usd <n>`,
          category: "budget_exceeded",
          dedupKey: `budget_exceeded:${event.taskId}:${event.payload.scope}`,
          severity: "action_required",
          sourceTraceId: event.eventId,
          summary: event.payload.reasons.join("; "),
          taskId: event.taskId,
          threadId: event.payload.threadId,
          title: "Budget exceeded",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "schedule_run_finished":
        if (event.payload.status !== "completed") {
          return;
        }
        {
          const schedule = this.dependencies.findSchedule(event.payload.scheduleId);
          const scheduleLabel = schedule?.name ?? event.payload.runId;
          this.dependencies.inboxService.append({
            category: "task_completed",
            dedupKey: `schedule_run_finished:${event.payload.runId}`,
            metadata: buildScheduleInboxMetadata(schedule),
            scheduleRunId: event.payload.runId,
            severity: "info",
            sourceTraceId: event.eventId,
            summary: `Routine completed: ${scheduleLabel}.`,
            taskId: event.payload.taskId ?? event.taskId,
            threadId: event.payload.threadId,
            title: `Routine completed: ${scheduleLabel}`,
            userId: this.resolveScheduleOwner(event.payload.scheduleId, event.taskId)
          });
        }
        return;
      case "schedule_run_failed": {
        const schedule = this.dependencies.findSchedule(event.payload.scheduleId);
        const scheduleRun = this.findScheduleRunByRunId(event.payload.taskId, event.payload.runId);
        const scheduleName = schedule?.name ?? event.payload.runId;
        const failureReason = [event.payload.errorCode, event.payload.errorMessage].filter(Boolean).join(": ") || "Scheduled routine failed";
        const metadata = buildScheduleInboxMetadata(schedule);
        if (schedule?.threadId !== null && schedule?.threadId !== undefined && !hasExternalScheduleOrigin(metadata)) {
          this.createFailedRoutineFollowUp(schedule, event.payload.runId, event.payload.taskId, failureReason);
          return;
        }
        this.dependencies.inboxService.append({
          category: "task_failed",
          dedupKey: `schedule_run_failed:${event.payload.runId}`,
          metadata,
          scheduleRunId: scheduleRun?.runId ?? event.payload.runId,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: failureReason,
          taskId: event.payload.taskId ?? event.taskId,
          threadId: schedule?.threadId ?? null,
          title: `Routine failed: ${scheduleName}`,
          userId: this.resolveScheduleOwner(event.payload.scheduleId, event.taskId)
        });
        return;
      }
      case "commitment_blocked":
        this.dependencies.inboxService.append({
          category: "task_blocked",
          dedupKey: `task_blocked:${event.payload.commitmentId}`,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: event.payload.blockedReason,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          title: "Task blocked",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "next_action_blocked":
        this.dependencies.inboxService.append({
          category: "task_blocked",
          dedupKey: `task_blocked:next_action:${event.payload.nextActionId}`,
          severity: "warning",
          sourceTraceId: event.eventId,
          summary: event.payload.blockedReason,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          title: "Next action blocked",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      case "commitment_updated":
        if (event.payload.status !== "waiting_decision" || event.payload.pendingDecision === null) {
          return;
        }
        this.dependencies.inboxService.append({
          category: "decision_requested",
          dedupKey: `decision_requested:${event.payload.commitmentId}`,
          severity: "action_required",
          sourceTraceId: event.eventId,
          summary: event.payload.pendingDecision,
          taskId: event.payload.taskId,
          threadId: event.payload.threadId,
          title: "Decision requested",
          userId: this.resolveUserId(event.taskId)
        });
        return;
      default:
        return;
    }
  }

  private resolveUserId(taskId: string): string {
    const task = this.dependencies.findTask(taskId);
    if (task !== null) {
      return task.requesterUserId;
    }
    const run = this.dependencies.listScheduleRunsByTask(taskId)[0];
    if (run !== undefined) {
      const schedule = this.dependencies.findSchedule(run.scheduleId);
      if (schedule !== null) {
        return schedule.ownerUserId;
      }
    }
    return "local-user";
  }

  private resolveScheduleOwner(scheduleId: string, fallbackTaskId: string): string {
    const schedule = this.dependencies.findSchedule(scheduleId);
    if (schedule !== null) {
      return schedule.ownerUserId;
    }
    return this.resolveUserId(fallbackTaskId);
  }

  private findRelatedScheduleRun(taskId: string): ScheduleRunRecord | null {
    return this.dependencies.listScheduleRunsByTask(taskId)[0] ?? null;
  }

  private findScheduleRunByRunId(taskId: string | null, runId: string): ScheduleRunRecord | null {
    if (taskId === null) {
      return null;
    }
    return this.dependencies.listScheduleRunsByTask(taskId).find((item) => item.runId === runId) ?? null;
  }

  private createFailedRoutineFollowUp(
    schedule: ScheduleRecord,
    runId: string,
    taskId: string | null,
    reason: string
  ): NextActionRecord {
    const created = this.dependencies.nextActionService.create({
      metadata: {
        runId,
        scheduleId: schedule.scheduleId,
        ...(taskId !== null ? { taskId } : {})
      },
      source: "manual",
      status: "blocked",
      taskId,
      threadId: schedule.threadId!,
      title: `Follow up failed routine: ${schedule.name}`
    });
    return this.dependencies.nextActionService.block(created.nextActionId, reason);
  }
}

function buildScheduleInboxMetadata(schedule: ScheduleRecord | null): JsonObject {
  if (schedule === null) {
    return {};
  }
  const metadata: JsonObject = {
    scheduleId: schedule.scheduleId
  };
  const origin = readJsonObject(schedule.metadata.origin);
  if (origin !== null) {
    metadata.origin = origin;
  }
  return metadata;
}

function buildApprovalInboxMetadata(schedule: ScheduleRecord | null, approvalId: string): JsonObject {
  return {
    ...buildScheduleInboxMetadata(schedule),
    approvalId
  };
}

function hasExternalScheduleOrigin(metadata: JsonObject): boolean {
  return readJsonObject(metadata.origin) !== null;
}

function readJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}
