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
  SessionRecord
} from "../src/types/index.js";

type TodayServiceStub = Pick<
  AgentApplicationService,
  "listCommitments" | "listInbox" | "listNextActions" | "listPendingApprovals" | "listSchedules" | "listSessions"
>;

describe("personal assistant slash commands", () => {
  it("publishes the new command order and hides dashboard", () => {
    expect(SLASH_COMMANDS.slice(0, 12)).toEqual([
      "/today",
      "/inbox",
      "/inbox show ",
      "/session",
      "/session new ",
      "/session list",
      "/session switch ",
      "/session summary ",
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
    expect(completeSlashCommand("/ses")).toBe("/session ");
    expect(completeSlashCommand("/co")).toBe("/commitments ");
    expect(completeSlashCommand("/session s")).toBe("/session switch ");
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
    const summary = buildTodaySummary(createServiceStub(), { activeSessionId: "session-a" });

    expect(summary.inbox.total).toBe(2);
    expect(summary.sessions.total).toBe(2);
    expect(summary.commitments.total).toBe(2);
    expect(summary.nextActions.total).toBe(2);
    expect(summary.pendingApprovals.total).toBe(2);
    expect(summary.dueRoutines.total).toBe(2);
    expect(summary.sessions.items[0]?.sessionId).toBe("session-a");
    expect(summary.commitments.items[0]?.sessionId).toBe("session-a");
    expect(summary.nextActions.items[0]?.sessionId).toBe("session-a");
    expect(summary.dueRoutines.items[0]?.scheduleId).toBe("schedule-overdue");
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function createServiceStub(): TodayServiceStub {
  const sessions: SessionRecord[] = [
    createSession("session-b", "2026-01-01T00:00:00.000Z"),
    createSession("session-a", "2026-01-01T01:00:00.000Z"),
    {
      ...createSession("session-z", "2026-01-01T02:00:00.000Z"),
      ownerUserId: "other-user"
    }
  ];
  const inbox: InboxItem[] = [
    createInbox("inbox-a", "session-a"),
    createInbox("inbox-b", "session-b")
  ];
  const commitments: CommitmentRecord[] = [
    createCommitment("commitment-b", "session-b"),
    createCommitment("commitment-a", "session-a")
  ];
  const nextActions: NextActionRecord[] = [
    createNextAction("next-b", "session-b", 2),
    createNextAction("next-a", "session-a", 1),
    createNextAction("next-ignore", "session-z", 0)
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
    listSessions() {
      return sessions;
    }
  } as TodayServiceStub;
}

function createSession(sessionId: string, updatedAt: string): SessionRecord {
  return {
    agentProfileId: "executor",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: process.cwd(),
    metadata: {},
    ownerUserId: "local-user",
    providerName: "mock",
    status: "active",
    sessionId,
    title: sessionId,
    updatedAt
  };
}

function createInbox(inboxId: string, sessionId: string): InboxItem {
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
    sessionId,
    title: inboxId,
    updatedAt: "2026-01-01T00:00:00.000Z",
    userId: "local-user"
  };
}

function createCommitment(commitmentId: string, sessionId: string): CommitmentRecord {
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
    sessionId,
    title: commitmentId,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createNextAction(nextActionId: string, sessionId: string, rank: number): NextActionRecord {
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
    sessionId,
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
    sessionId: null,
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
