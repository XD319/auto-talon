import { PassThrough } from "node:stream";

import { render } from "ink";
import React from "react";
import { describe, expect, it } from "vitest";

import type { AgentApplicationService } from "../src/runtime/index.js";
import { HomeSummary } from "../src/tui/components/home-summary.js";
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

    expect(summary.title).toBe("");
    expect(summary.agenda).toEqual([
      "Approval needed: file_write",
      "Routine ready: Morning review",
      "Continue: Draft the plan outline"
    ]);
    expect(summary.actions.map((item) => item.label)).toEqual([
      "Respond to approval",
      "Open routine"
    ]);
    expect(summary.recommendedThread?.label).toBe("Quarterly planning");
    expect(summary.recentThreads.map((item) => item.label)).toEqual([
      "Quarterly planning",
      "Release checklist",
      "Research notes"
    ]);
    expect(summary.assistantHint).toBe("Use Up/Down and Enter to open an item.");
  });

  it("does not render a home panel when nothing is open", async () => {
    const summary = buildHomeSummary(createEmptyServiceStub());

    expect(summary.recommendedThread).toBeNull();
    expect(summary.recentThreads).toEqual([]);
    expect(summary.actions).toEqual([]);
    expect(summary.agenda).toEqual([]);
    expect(listHomeSummaryEntries(summary)).toEqual([]);

    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    const app = render(React.createElement(HomeSummary, { summary }), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitForInk();
      expect(output).not.toContain("Today at a glance");
      expect(output).not.toContain("Open items");
    } finally {
      app.unmount();
      await app.waitUntilExit();
    }
  });

  it("uses the top next action as the attention fallback when no urgent items exist", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [];
      },
      listPendingApprovals() {
        return [];
      },
      listSchedules() {
        return [];
      }
    };
    const summary = buildHomeSummary(service);

    expect(summary.actions).toEqual([]);
    expect(summary.agenda[0]).toBe("Continue: Draft the plan outline");
    expect(listHomeSummaryEntries(summary)[0]).toMatchObject({
      kind: "thread",
      label: "Continue Wrap the planning task",
      threadId: "thread-a"
    });
  });

  it("builds keyboard-selectable entries with actionable items first", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub(), { activeThreadId: "thread-a" });
    const entries = listHomeSummaryEntries(summary);

    expect(entries.slice(0, 3)).toMatchObject([
      {
        key: "approval",
        kind: "action",
        label: "Respond to approval",
        threadId: "thread-a"
      },
      {
        key: "routine",
        kind: "action",
        label: "Open routine"
      },
      {
        kind: "thread",
        label: "Continue Wrap the planning task",
        threadId: "thread-a"
      }
    ]);
    expect(entries.slice(3, 4)).toMatchObject([
      {
        kind: "thread",
        label: "Continue Check final release blockers",
        threadId: "thread-b"
      }
    ]);
  });

  it("uses specific labels for actionable inbox items", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          createInbox("inbox-action", "Decision requested", "thread-a", {
            category: "decision_requested",
            severity: "action_required",
            summary: "Choose whether to publish the draft."
          })
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeThreadId: "thread-a" });

    expect(summary.agenda).toContain("Review: Quarterly planning - Decision requested");
    expect(summary.actions.find((item) => item.key === "inbox")).toMatchObject(
      {
        detail: "Decision needed: Choose whether to publish the draft.",
        key: "inbox",
        label: "Open inbox: Quarterly planning - Decision requested",
        threadId: "thread-a"
      }
    );
  });

  it("deduplicates thread suggestions by visible title", () => {
    process.env.USERNAME = "local-user";
    const duplicateThreads = [
      createThread("thread-a", "Repeated reminder", "2026-01-01T03:00:00.000Z"),
      createThread("thread-b", "Repeated reminder", "2026-01-01T02:00:00.000Z")
    ];
    const service = {
      ...createEmptyServiceStub(),
      listThreads() {
        return duplicateThreads;
      },
      showThread(threadId: string) {
        const thread = duplicateThreads.find((item) => item.threadId === threadId) ?? null;
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [],
          runs: [createThreadRun(`run-${threadId}`, threadId, 1, "completed", "same prompt")],
          scheduleRuns: [],
          state: {
            activeNextActions: [],
            blockedReason: null,
            currentObjective: null,
            nextAction: createNextAction(`next-${threadId}`, threadId, threadId === "thread-a" ? "first detail" : "second detail"),
            openCommitments: [],
            pendingDecision: null
          },
          thread
        };
      }
    };
    const summary = buildHomeSummary(service);

    expect(listHomeSummaryEntries(summary).filter((entry) => entry.kind === "thread")).toHaveLength(1);
  });

  it("keeps completed inbox noise off the home agenda", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createEmptyServiceStub(),
      listInbox() {
        return [
          createInbox("completed-a", "Task completed", "thread-a", {
            summary: "This is a long completed task summary that should stay out of the home agenda."
          })
        ];
      }
    };
    const summary = buildHomeSummary(service);

    expect(summary.agenda).toEqual([]);
    expect(summary.actions).toEqual([]);
  });

  it("humanizes provider and path errors in quick actions", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          createInbox("blocked-a", "Next action blocked", "thread-a", {
            category: "task_blocked",
            severity: "warning",
            summary:
              "provider_error: xunfei response error: sid: cht000 msg: EngineInternalError; EISDIR: illegal operation on a directory, read"
          })
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeThreadId: "thread-a" });
    const inboxAction = summary.actions.find((item) => item.key === "inbox");

    expect(summary.agenda).toContain("Review: Quarterly planning");
    expect(inboxAction?.label).toBe("Open inbox: Quarterly planning");
    expect(inboxAction?.detail).toBe("Blocked: A directory was used where a file path was expected.");
  });

  it("keeps assistant narrative out of agenda continuation labels", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [];
      },
      listPendingApprovals() {
        return [];
      },
      listSchedules() {
        return [];
      },
      listNextActions() {
        return [
          createNextAction(
            "next-long",
            "thread-a",
            "I found the old notes and can now continue. Let me prepare the full answer with the details you asked for, including the source context and the next concrete step."
          )
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeThreadId: "thread-a" });

    expect(summary.agenda[0]).toBe("Continue: Wrap the planning task");
    expect(listHomeSummaryEntries(summary)[0]).toMatchObject({
      kind: "thread",
      label: "Continue Wrap the planning task",
      threadId: "thread-a"
    });
  });

  it("limits the home list to the highest value entries", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          createInbox("inbox-action", "Decision requested", "thread-a", {
            category: "decision_requested",
            severity: "action_required",
            summary: "Choose whether to publish the draft."
          })
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeThreadId: "thread-a" });
    const entries = listHomeSummaryEntries(summary);

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.kind)).toEqual(["action", "action", "action", "thread"]);
  });

  it("recommends the thread with the highest-priority next action before recent history", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub());
    const entries = listHomeSummaryEntries(summary);
    const firstThread = entries.find((entry) => entry.kind === "thread");

    expect(summary.recentThreads.map((item) => item.label)).toEqual([
      "Release checklist",
      "Research notes",
      "Quarterly planning"
    ]);
    expect(summary.recommendedThread?.label).toBe("Quarterly planning");
    expect(firstThread).toMatchObject({
      kind: "thread",
      label: "Continue Wrap the planning task",
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

  it("keeps completed notification noise and duplicate decisions out of thread details", () => {
    const baseService = createServiceStub();
    const service = {
      ...baseService,
      showThread(threadId: string) {
        const detail = baseService.showThread(threadId);
        return {
          ...detail,
          inboxItems: [
            createInbox("completed-a", "Task completed", "thread-a"),
            createInbox("routine-a", "Routine completed: 飞书一分钟定时测试", "thread-a"),
            createInbox("blocked-a", "Need review", "thread-a", {
              category: "task_blocked",
              severity: "warning",
              summary: "Needs review before continuing."
            })
          ],
          state: {
            ...detail.state,
            pendingDecision: "Wrap the planning task"
          }
        };
      }
    };
    const detail = formatThreadDetailForTui(service as AgentApplicationService, "thread-a");

    expect(detail).not.toContain("decision: Wrap the planning task");
    expect(detail).not.toContain("Task completed [pending]");
    expect(detail).not.toContain("Routine completed: 飞书一分钟定时测试");
    expect(detail).toContain("recent inbox:");
    expect(detail).toContain("- Need review [pending]");
  });
});

async function waitForInk(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

function createInbox(
  inboxId: string,
  title: string,
  threadId: string,
  overrides: Partial<Pick<InboxItem, "category" | "severity" | "summary">> = {}
): InboxItem {
  return {
    actionHint: null,
    approvalId: null,
    bodyMd: null,
    category: overrides.category ?? "task_completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    dedupKey: null,
    doneAt: null,
    experienceId: null,
    inboxId,
    metadata: {},
    scheduleRunId: null,
    severity: overrides.severity ?? "info",
    skillId: null,
    sourceTraceId: null,
    status: "pending",
    summary: overrides.summary ?? title,
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
