import { afterEach, describe, expect, it, vi } from "vitest";

import { SLASH_COMMANDS, completeSlashCommand } from "../src/tui/slash-commands.js";
import { buildTodaySummary } from "../src/tui/view-models/today-summary.js";
import type { AgentApplicationService } from "../src/runtime/index.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ScheduleRecord,
  ThreadRecord
} from "../src/types/index.js";

type TodayServiceStub = Pick<
  AgentApplicationService,
  "listCommitments" | "listInbox" | "listNextActions" | "listPendingApprovals" | "listSchedules" | "listThreads"
>;

describe("personal assistant slash commands", () => {
  it("publishes the new command order and hides dashboard", () => {
    expect(SLASH_COMMANDS.slice(0, 11)).toEqual([
      "/today",
      "/inbox",
      "/thread",
      "/thread new ",
      "/thread list",
      "/thread switch ",
      "/thread summary ",
      "/next",
      "/next list",
      "/next done ",
      "/next block "
    ]);
    expect(SLASH_COMMANDS).not.toContain("/dashboard");
    expect(SLASH_COMMANDS).toContain("/schedule create ");
    expect(SLASH_COMMANDS).toContain("/schedule list ");
    expect(SLASH_COMMANDS).toContain("/schedule pause ");
    expect(SLASH_COMMANDS).toContain("/schedule resume ");
    expect(SLASH_COMMANDS).toContain("/schedule run-now ");
    expect(SLASH_COMMANDS).toContain("/schedule runs ");
    expect(SLASH_COMMANDS).toContain("/schedule remove ");
  });

  it("completes personal workflow commands by prefix", () => {
    expect(completeSlashCommand("/t")).toBe("/today ");
    expect(completeSlashCommand("/r")).toBe("/resume ");
    expect(completeSlashCommand("/th")).toBe("/thread ");
    expect(completeSlashCommand("/co")).toBe("/commitments ");
    expect(completeSlashCommand("/thread s")).toBe("/thread switch ");
    expect(completeSlashCommand("/next d")).toBe("/next done ");
    expect(completeSlashCommand("/commitments b")).toBe("/commitments block ");
    expect(completeSlashCommand("/schedule c")).toBe("/schedule create ");
  });
});

describe("today summary view model", () => {
  it("aggregates user-scoped sections and prioritizes active thread", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00.000Z"));
    process.env.USERNAME = "local-user";
    const summary = buildTodaySummary(createServiceStub(), { activeThreadId: "thread-a" });

    expect(summary.inbox.total).toBe(2);
    expect(summary.threads.total).toBe(2);
    expect(summary.commitments.total).toBe(2);
    expect(summary.nextActions.total).toBe(2);
    expect(summary.pendingApprovals.total).toBe(2);
    expect(summary.dueRoutines.total).toBe(2);
    expect(summary.threads.items[0]?.threadId).toBe("thread-a");
    expect(summary.commitments.items[0]?.threadId).toBe("thread-a");
    expect(summary.nextActions.items[0]?.threadId).toBe("thread-a");
    expect(summary.dueRoutines.items[0]?.scheduleId).toBe("schedule-overdue");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function createServiceStub(): TodayServiceStub {
  const threads: ThreadRecord[] = [
    createThread("thread-b", "2026-01-01T00:00:00.000Z"),
    createThread("thread-a", "2026-01-01T01:00:00.000Z"),
    {
      ...createThread("thread-z", "2026-01-01T02:00:00.000Z"),
      ownerUserId: "other-user"
    }
  ];
  const inbox: InboxItem[] = [
    createInbox("inbox-a", "thread-a"),
    createInbox("inbox-b", "thread-b")
  ];
  const commitments: CommitmentRecord[] = [
    createCommitment("commitment-b", "thread-b"),
    createCommitment("commitment-a", "thread-a")
  ];
  const nextActions: NextActionRecord[] = [
    createNextAction("next-b", "thread-b", 2),
    createNextAction("next-a", "thread-a", 1),
    createNextAction("next-ignore", "thread-z", 0)
  ];
  const approvals: ApprovalRecord[] = [createApproval("approval-2"), createApproval("approval-1")];
  const schedules: ScheduleRecord[] = [
    createSchedule("schedule-today", "2026-01-01T10:00:00.000Z"),
    createSchedule("schedule-overdue", "2025-12-31T23:00:00.000Z"),
    createSchedule("schedule-later", "2026-01-02T10:00:00.000Z"),
    {
      ...createSchedule("schedule-paused", "2026-01-01T11:00:00.000Z"),
      status: "paused"
    }
  ];

  return {
    listCommitments() {
      return commitments;
    },
    listInbox() {
      return inbox;
    },
    listNextActions() {
      return nextActions;
    },
    listPendingApprovals() {
      return approvals;
    },
    listSchedules(query?: { ownerUserId?: string; status?: "active" | "paused" | "completed" | "archived" }) {
      return schedules.filter(
        (item) =>
          (query?.ownerUserId === undefined || item.ownerUserId === query.ownerUserId) &&
          (query?.status === undefined || item.status === query.status)
      );
    },
    listThreads() {
      return threads;
    }
  } as TodayServiceStub;
}

function createThread(threadId: string, updatedAt: string): ThreadRecord {
  return {
    agentProfileId: "executor",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: process.cwd(),
    metadata: {},
    ownerUserId: "local-user",
    providerName: "mock",
    status: "active",
    threadId,
    title: threadId,
    updatedAt
  };
}

function createInbox(inboxId: string, threadId: string): InboxItem {
  return {
    actionHint: null,
    approvalId: null,
    bodyMd: null,
    category: "task_completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    dedupKey: null,
    doneAt: null,
    experienceId: null,
    inboxId,
    metadata: {},
    scheduleRunId: null,
    severity: "info",
    skillId: null,
    sourceTraceId: null,
    status: "pending",
    summary: inboxId,
    taskId: null,
    threadId,
    title: inboxId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    userId: "local-user"
  };
}

function createCommitment(commitmentId: string, threadId: string): CommitmentRecord {
  return {
    blockedReason: null,
    commitmentId,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    dueAt: null,
    metadata: {},
    ownerUserId: "local-user",
    pendingDecision: null,
    source: "manual",
    sourceTraceId: null,
    status: "open",
    summary: commitmentId,
    taskId: null,
    threadId,
    title: commitmentId,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createNextAction(nextActionId: string, threadId: string, rank: number): NextActionRecord {
  return {
    blockedReason: null,
    commitmentId: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    detail: null,
    dueAt: null,
    metadata: {},
    nextActionId,
    rank,
    source: "manual",
    sourceTraceId: null,
    status: "pending",
    taskId: null,
    threadId,
    title: nextActionId,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createApproval(approvalId: string): ApprovalRecord {
  return {
    approvalId,
    decidedAt: null,
    errorCode: null,
    expiresAt: approvalId === "approval-1" ? "2026-01-01T00:00:00.000Z" : "2026-01-01T01:00:00.000Z",
    policyDecisionId: "policy",
    reason: "reason",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "local-user",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId: "task",
    toolCallId: "call",
    toolName: "file_write"
  };
}

function createSchedule(scheduleId: string, nextFireAt: string): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    cron: null,
    cwd: process.cwd(),
    input: "scheduled prompt",
    intervalMs: 60_000,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: {},
    name: scheduleId,
    nextFireAt,
    ownerUserId: "local-user",
    providerName: "mock",
    runAt: null,
    scheduleId,
    status: "active",
    threadId: null,
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
