import type { TraceEvent, TaskRecord } from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import { resolveDefaultUserId } from "../runtime-identity.js";
import type { SessionSummaryService } from "../context/session-summary-service.js";
import type { CommitmentService } from "./commitment-service.js";
import type { NextActionService } from "./next-action-service.js";

export interface CommitmentCollectorDependencies {
  traceService: TraceService;
  sessionSummaryService: SessionSummaryService;
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
  findTask: (taskId: string) => TaskRecord | null;
}

export class CommitmentCollector {
  private unsubscribe: (() => void) | null = null;

  public constructor(private readonly dependencies: CommitmentCollectorDependencies) {}

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
      case "task_created":
        this.onTaskCreated(event);
        return;
      case "session_summary_written":
        this.onSessionSummary(event);
        return;
      case "approval_requested":
        this.onApprovalRequested(event);
        return;
      case "approval_resolved":
        this.onApprovalResolved(event);
        return;
      case "task_success":
        this.onTaskSuccess(event);
        return;
      case "task_failure":
        this.onTaskFailure(event);
        return;
      default:
        return;
    }
  }

  private onTaskCreated(event: Extract<TraceEvent, { eventType: "task_created" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.sessionId === undefined || task.sessionId === null) {
      return;
    }
    const existing = this.dependencies.commitmentService.list({
      statuses: ["open", "in_progress", "blocked", "waiting_decision"],
      sessionId: task.sessionId
    });
    if (existing.length === 0) {
      const commitment = this.dependencies.commitmentService.create({
        ownerUserId: task.requesterUserId,
        source: "user_request",
        sourceTraceId: event.eventId,
        status: "in_progress",
        summary: task.input,
        taskId: task.taskId,
        sessionId: task.sessionId,
        title: task.input.slice(0, 160)
      });
      this.dependencies.nextActionService.create({
        commitmentId: commitment.commitmentId,
        rank: 0,
        source: "user_request",
        sourceTraceId: event.eventId,
        status: "active",
        taskId: task.taskId,
        sessionId: task.sessionId,
        title: task.input.slice(0, 160)
      });
      return;
    }
    const actions = this.dependencies.nextActionService.list({
      statuses: ["pending", "active", "blocked"],
      sessionId: task.sessionId
    });
    if (actions.length === 0) {
      this.dependencies.nextActionService.create({
        commitmentId: existing[0]?.commitmentId ?? null,
        rank: 0,
        source: "user_request",
        sourceTraceId: event.eventId,
        status: "active",
        taskId: task.taskId,
        sessionId: task.sessionId,
        title: task.input.slice(0, 160)
      });
    }
  }

  private onSessionSummary(event: Extract<TraceEvent, { eventType: "session_summary_written" }>): void {
    const sessionSummary = this.dependencies.sessionSummaryService.findById(event.payload.sessionSummaryId);
    if (sessionSummary === null) {
      return;
    }
    const commitments = this.dependencies.commitmentService.list({
      statuses: ["open", "in_progress", "blocked", "waiting_decision"],
      sessionId: sessionSummary.sessionId
    });
    const nextActions = sessionSummary.nextActions.filter((title) =>
      shouldProjectSessionNextAction(title)
    );
    if (commitments.length === 0 && nextActions.length === 0 && sessionSummary.openLoops.length === 0) {
      return;
    }
    const objective = sessionSummary.goal.trim().slice(0, 160);
    const task =
      sessionSummary.taskId === null ? null : this.dependencies.findTask(sessionSummary.taskId);
    const ownerUserId = task?.requesterUserId ?? resolveDefaultUserId();
    const commitment =
      commitments[0] ??
      this.dependencies.commitmentService.create({
        ownerUserId,
        source: "snapshot",
        sourceTraceId: event.eventId,
        status: "in_progress",
        summary: sessionSummary.summary,
        taskId: sessionSummary.taskId,
        sessionId: sessionSummary.sessionId,
        title: objective.length > 0 ? objective : "Continue session objective"
      });
    if (sessionSummary.openLoops.length > 0) {
      this.dependencies.commitmentService.block(commitment.commitmentId, sessionSummary.openLoops[0]!);
    }
    const existing = this.dependencies.nextActionService.list({
      statuses: ["pending", "active", "blocked"],
      sessionId: sessionSummary.sessionId
    });
    if (existing.length === 0) {
      nextActions.forEach((title, index) => {
        this.dependencies.nextActionService.create({
          commitmentId: commitment.commitmentId,
          rank: index,
          source: "snapshot",
          sourceTraceId: event.eventId,
          status: index === 0 ? "active" : "pending",
          taskId: sessionSummary.taskId,
          sessionId: sessionSummary.sessionId,
          title
        });
      });
    }
  }

  private onApprovalRequested(event: Extract<TraceEvent, { eventType: "approval_requested" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.sessionId === undefined || task.sessionId === null) {
      return;
    }
    const active = this.dependencies.nextActionService.list({
      statuses: ["active", "pending"],
      sessionId: task.sessionId
    })[0];
    if (active !== undefined) {
      this.dependencies.nextActionService.block(
        active.nextActionId,
        `awaiting approval: ${event.payload.toolName}`
      );
    }
  }

  private onApprovalResolved(event: Extract<TraceEvent, { eventType: "approval_resolved" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.sessionId === undefined || task.sessionId === null) {
      return;
    }
    const blocked = this.dependencies.nextActionService.list({
      status: "blocked",
      sessionId: task.sessionId
    })[0];
    if (blocked === undefined) {
      return;
    }
    if (event.payload.status === "approved") {
      this.dependencies.nextActionService.unblock(blocked.nextActionId);
      return;
    }
    this.dependencies.nextActionService.block(
      blocked.nextActionId,
      `approval ${event.payload.status}: ${event.payload.toolName}`
    );
  }

  private onTaskSuccess(event: Extract<TraceEvent, { eventType: "task_success" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.sessionId === undefined || task.sessionId === null) {
      return;
    }
    const active = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      sessionId: task.sessionId
    })[0];
    if (active === undefined) {
      return;
    }
    this.dependencies.nextActionService.markDone(active.nextActionId);
    const remaining = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      sessionId: task.sessionId
    });
    if (remaining.length === 0 && active.commitmentId !== null) {
      this.dependencies.commitmentService.complete(active.commitmentId);
    }
  }

  private onTaskFailure(event: Extract<TraceEvent, { eventType: "task_failure" }>): void {
    const task = this.dependencies.findTask(event.taskId);
    if (task?.sessionId === undefined || task.sessionId === null) {
      return;
    }
    const active = this.dependencies.nextActionService.list({
      statuses: ["active", "pending", "blocked"],
      sessionId: task.sessionId
    })[0];
    if (active === undefined) {
      return;
    }
    this.dependencies.nextActionService.block(
      active.nextActionId,
      `${event.payload.errorCode}: ${event.payload.errorMessage}`
    );
  }
}

function shouldProjectSessionNextAction(title: string): boolean {
  const compact = title.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return false;
  }
  if (
    /\b(no files? (?:were )?changed|no changes? (?:were )?made|nothing changed|completed|implemented|fixed|summary)\b/iu.test(
      compact
    )
  ) {
    return false;
  }
  if (
    /(?:\u6ca1\u6709\u4fee\u6539|\u6ca1\u6709\u6539\u52a8|\u672a\u4fee\u6539|\u672a\u6539\u52a8|\u5df2\u5b8c\u6210|\u5df2\u5b9e\u73b0|\u603b\u7ed3)/u.test(
      compact
    )
  ) {
    return false;
  }
  return true;
}
