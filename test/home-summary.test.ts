import { describe, expect, it } from "vitest";

import type { AgentApplicationService } from "../src/runtime/index.js";
import { buildHomeSummary, listHomeSummaryEntries } from "../src/tui/view-models/home-summary.js";
import { formatThreadDetailForTui } from "../src/tui/view-models/today-summary.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ScheduleRecord,
  ScheduleRunRecord,
  ThreadRecord,
  ThreadRunRecord
} from "../src/types/index.js";

type HomeServiceStub = Pick<
  AgentApplicationService,
  | "listCommitments"
  | "listInbox"
  | "listNextActions"
  | "listPendingApprovals"
  | "listSchedules"
  | "listThreads"
  | "showTask"
  | "showThread"
>;

describe("home summary", () => {
  it("prioritizes urgent workflow items and recent thread guidance", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub(), { activeThreadId: "thread-a" });

    expect(summary.title).toBe("Today at a glance");
    expect(summary.agenda[0]).toContain("Routine due");
    expect(summary.actions.map((item) => item.label)).toEqual([
      "Review pending approval",
      "Triage inbox",
      "Check due routine"
    ]);
    expect(summary.recommendedThread?.label).toBe("Quarterly planning");
    expect(summary.recentThreads.map((item) => item.label)).toEqual([
      "Quarterly planning",
      "Release checklist",
      "Research notes"
    ]);
    expect(summary.assistantHint).toContain("Use Up/Down");
  });

  it("falls back to a new-task prompt when nothing is pending", () => {
    const summary = buildHomeSummary(createEmptyServiceStub());

    expect(summary.recommendedThread).toBeNull();
    expect(summary.recentThreads).toEqual([]);
    expect(summary.actions).toEqual([
      {
        detail: "Start with a plain-language goal or ask for today's plan.",
        key: "start",
        label: "Start a new task"
      }
    ]);
    expect(summary.agenda[0]).toContain("No urgent items");
  });

  it("builds keyboard-selectable entries with recent threads first", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub(), { activeThreadId: "thread-a" });
    const entries = listHomeSummaryEntries(summary);

    expect(entries.slice(0, 3)).toMatchObject([
      {
        kind: "thread",
        label: "Quarterly planning",
        threadId: "thread-a"
      },
      {
        kind: "thread",
        label: "Release checklist",
        threadId: "thread-b"
      },
      {
        kind: "thread",
        label: "Research notes",
        threadId: "thread-c"
      }
    ]);
    expect(entries[3]).toMatchObject({
      key: "approval",
      kind: "action",
      label: "Review pending approval",
      threadId: "thread-a"
    });
  });

  it("formats thread detail with a useful preview instead of only counts", () => {
    const detail = formatThreadDetailForTui(createServiceStub() as AgentApplicationService, "thread-a");

    expect(detail).toContain("Thread thread-a | Quarterly planning");
    expect(detail).toContain("objective: Wrap the planning task [open]");
    expect(detail).toContain("next: Draft the plan outline [pending]");
    expect(detail).toContain("recent inbox:");
    expect(detail).toContain("- Need review [pending]");
    expect(detail).toContain("recent runs:");
    expect(detail).toContain("#2 waiting_approval | Need permission to write release notes");
    expect(detail).toContain("recent schedules:");
  });
});

function createServiceStub(): HomeServiceStub {
  const threads = [
    createThread("thread-a", "Quarterly planning", "2026-01-01T01:00:00.000Z"),
    createThread("thread-b", "Release checklist", "2026-01-01T03:00:00.000Z"),
    createThread("thread-c", "Research notes", "2026-01-01T02:00:00.000Z")
  ];
  const threadMap = new Map(threads.map((thread) => [thread.threadId, thread]));

  return {
    listCommitments() {
      return [createCommitment("commitment-a", "thread-a")];
    },
    listInbox() {
      return [createInbox("inbox-a", "Need review", "thread-a")];
    },
    listNextActions() {
      return [createNextAction("next-a", "thread-a")];
    },
    listPendingApprovals() {
      return [createApproval("approval-a")];
    },
    listSchedules() {
      return [createSchedule("schedule-a", "Morning review")];
    },
    listThreads() {
      return threads;
    },
    showTask() {
      return {
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: {
          agentProfileId: "executor",
          createdAt: "2026-01-01T00:00:00.000Z",
          currentIteration: 0,
          cwd: process.cwd(),
          errorCode: null,
          errorMessage: null,
          finalOutput: null,
          finishedAt: null,
          input: "Need permission",
          maxIterations: 4,
          metadata: {},
          providerName: "mock",
          requesterUserId: "local-user",
          startedAt: "2026-01-01T00:00:00.000Z",
          status: "waiting_approval",
          taskId: "task-1",
          threadId: "thread-a",
          tokenBudget: {
            hardCostUsd: null,
            hardInputTokens: null,
            hardOutputTokens: null,
            softCostUsd: null,
            softInputTokens: null,
            softOutputTokens: null
          },
          updatedAt: "2026-01-01T01:00:00.000Z"
        },
        toolCalls: [],
        trace: []
      };
    },
    showThread(threadId) {
      const thread = threadMap.get(threadId) ?? null;
      if (thread === null) {
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [],
          runs: [],
          scheduleRuns: [],
          state: {
            activeNextActions: [],
            blockedReason: null,
            currentObjective: null,
            nextAction: null,
            openCommitments: [],
            pendingDecision: null
          },
          thread: null
        };
      }
      if (threadId === "thread-a") {
        return {
          commitments: [createCommitment("commitment-a", thread.threadId)],
          inboxItems: [createInbox("inbox-a", "Need review", thread.threadId)],
          lineage: [],
          nextActions: [createNextAction("next-a", thread.threadId)],
          runs: [
            createThreadRun("run-2", thread.threadId, 2, "waiting_approval", "Need permission to write release notes"),
            createThreadRun("run-1", thread.threadId, 1, "completed", "Draft the quarterly plan")
          ],
          scheduleRuns: [createScheduleRun("schedule-a", thread.threadId, "waiting_approval")],
          state: {
            activeNextActions: [createNextAction("next-a", thread.threadId)],
            blockedReason: null,
            currentObjective: createCommitment("commitment-a", thread.threadId),
            nextAction: createNextAction("next-a", thread.threadId),
            openCommitments: [createCommitment("commitment-a", thread.threadId)],
            pendingDecision: null
          },
          thread
        };
      }
      if (threadId === "thread-b") {
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [createNextAction("next-b", thread.threadId, "Check final release blockers")],
          runs: [createThreadRun("run-3", thread.threadId, 3, "running", "Validate RC build and changelog")],
          scheduleRuns: [],
          state: {
            activeNextActions: [createNextAction("next-b", thread.threadId, "Check final release blockers")],
            blockedReason: null,
            currentObjective: null,
            nextAction: createNextAction("next-b", thread.threadId, "Check final release blockers"),
            openCommitments: [],
            pendingDecision: null
          },
          thread
        };
      }
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        runs: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: "Waiting on experiment results",
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        thread
      };
    }
  };
}

function createEmptyServiceStub(): HomeServiceStub {
  return {
    listCommitments() {
      return [];
    },
    listInbox() {
      return [];
    },
    listNextActions() {
      return [];
    },
    listPendingApprovals() {
      return [];
    },
    listSchedules() {
      return [];
    },
    listThreads() {
      return [];
    },
    showTask() {
      return {
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: null,
        toolCalls: [],
        trace: []
      };
    },
    showThread() {
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        runs: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: null,
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        thread: null
      };
    }
  };
}

function createThread(threadId: string, title: string, updatedAt: string): ThreadRecord {
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
    title,
    updatedAt
  };
}

function createInbox(inboxId: string, title: string, threadId: string): InboxItem {
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
    summary: title,
    taskId: null,
    threadId,
    title,
    updatedAt: "2026-01-01T01:00:00.000Z",
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
    summary: "Wrap the planning task",
    taskId: null,
    threadId,
    title: "Wrap the planning task",
    updatedAt: "2026-01-01T01:00:00.000Z"
  };
}

function createNextAction(nextActionId: string, threadId: string, title = "Draft the plan outline"): NextActionRecord {
  return {
    blockedReason: null,
    commitmentId: null,
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    detail: null,
    dueAt: null,
    metadata: {},
    nextActionId,
    rank: 1,
    source: "manual",
    sourceTraceId: null,
    status: "pending",
    taskId: null,
    threadId,
    title,
    updatedAt: "2026-01-01T01:00:00.000Z"
  };
}

function createApproval(approvalId: string): ApprovalRecord {
  return {
    approvalId,
    decidedAt: null,
    errorCode: null,
    expiresAt: "2026-01-01T02:00:00.000Z",
    policyDecisionId: "policy-1",
    reason: "Need permission",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "local-user",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "file_write"
  };
}

function createSchedule(scheduleId: string, name: string): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    cron: null,
    cwd: process.cwd(),
    input: "review inbox",
    intervalMs: 60_000,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: {},
    name,
    nextFireAt: "2025-12-31T23:00:00.000Z",
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

function createThreadRun(
  runId: string,
  threadId: string,
  runNumber: number,
  status: ThreadRunRecord["status"],
  input: string
): ThreadRunRecord {
  return {
    createdAt: `2026-01-01T0${runNumber}:00:00.000Z`,
    finishedAt: status === "completed" ? `2026-01-01T0${runNumber}:30:00.000Z` : null,
    input,
    metadata: {},
    runId,
    runNumber,
    status,
    summary: {},
    taskId: `task-${runNumber}`,
    threadId
  };
}

function createScheduleRun(
  scheduleId: string,
  threadId: string,
  status: ScheduleRunRecord["status"]
): ScheduleRunRecord {
  return {
    attemptNumber: 1,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    metadata: {},
    runId: "schedule-run-1",
    scheduleId,
    scheduledAt: "2026-01-01T01:30:00.000Z",
    startedAt: "2026-01-01T01:31:00.000Z",
    status,
    taskId: "task-2",
    threadId,
    trigger: "scheduled"
  };
}
