import { describe, expect, it } from "vitest";

import type { AgentApplicationService } from "../src/runtime/index.js";
import { buildHomeSummary, listHomeSummaryEntries } from "../src/tui/view-models/home-summary.js";
import { formatSessionDetailForTui, formatSessionRecapForTui } from "../src/tui/view-models/today-summary.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ScheduleRecord,
  ScheduleRunRecord,
  SessionRecord,
  SessionTaskRecord
} from "../src/types/index.js";

type HomeServiceStub = Pick<
  AgentApplicationService,
  | "listCommitments"
  | "listInbox"
  | "listNextActions"
  | "listPendingApprovals"
  | "listSchedules"
  | "listSessions"
  | "showTask"
  | "showSession"
>;

describe("home summary", () => {
  it("prioritizes urgent workflow items and recent session guidance", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub(), { activeSessionId: "session-a" });

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
    expect(summary.recommendedSession?.label).toBe("Quarterly planning");
    expect(summary.recentSessions.map((item) => item.label)).toEqual([
      "Quarterly planning",
      "Release checklist",
      "Research notes"
    ]);
    expect(summary.assistantHint).toBe("Type a request below, or use Up/Down and Enter to open a next step.");
  });

  it("builds a start path when nothing is open", () => {
    const summary = buildHomeSummary(createEmptyServiceStub());

    expect(summary.recommendedSession).toBeNull();
    expect(summary.recentSessions).toEqual([]);
    expect(summary.actions).toEqual([
      {
        detail: "Describe what you want AutoTalon to do in the prompt below.",
        key: "start",
        label: "Start a task"
      }
    ]);
    expect(summary.agenda).toEqual([]);
    expect(listHomeSummaryEntries(summary)).toMatchObject([
      {
        detail: "Describe what you want AutoTalon to do in the prompt below.",
        key: "start",
        kind: "action",
        label: "Start a task"
      }
    ]);

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

    expect(summary.actions).toMatchObject([
      {
        key: "start",
        label: "Start a task"
      }
    ]);
    expect(summary.agenda[0]).toBe("Continue: Draft the plan outline");
    expect(listHomeSummaryEntries(summary).find((entry) => entry.kind === "session")).toMatchObject({
      kind: "session",
      label: "Continue Wrap the planning task",
      sessionId: "session-a"
    });
  });

  it("builds keyboard-selectable entries with actionable items first", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub(), { activeSessionId: "session-a" });
    const entries = listHomeSummaryEntries(summary);

    expect(entries.slice(0, 3)).toMatchObject([
      {
        key: "approval",
        kind: "action",
        label: "Respond to approval",
        sessionId: "session-a"
      },
      {
        key: "routine",
        kind: "action",
        label: "Open routine"
      },
      {
        kind: "session",
        label: "Continue Wrap the planning task",
        sessionId: "session-a"
      }
    ]);
    expect(entries.slice(3, 4)).toMatchObject([
      {
        kind: "session",
        label: "Continue Check final release blockers",
        sessionId: "session-b"
      }
    ]);
  });

  it("uses specific labels for actionable inbox items", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          createInbox("inbox-action", "Decision requested", "session-a", {
            category: "decision_requested",
            severity: "action_required",
            summary: "Choose whether to publish the draft."
          })
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeSessionId: "session-a" });

    expect(summary.agenda).not.toContain("Needs attention: Quarterly planning - Decision requested");
    expect(summary.actions.find((item) => item.key === "inbox")).toMatchObject(
      {
        detail: "Decision needed: Choose whether to publish the draft.",
        inboxId: "inbox-action",
        key: "inbox",
        label: "Open inbox: Quarterly planning - Decision requested",
        sessionId: "session-a"
      }
    );
  });

  it("deduplicates session suggestions by visible title", () => {
    process.env.USERNAME = "local-user";
    const duplicateSessions = [
      createSession("session-a", "Repeated reminder", "2026-01-01T03:00:00.000Z"),
      createSession("session-b", "Repeated reminder", "2026-01-01T02:00:00.000Z")
    ];
    const service = {
      ...createEmptyServiceStub(),
      listSessions() {
        return duplicateSessions;
      },
      showSession(sessionId: string) {
        const session = duplicateSessions.find((item) => item.sessionId === sessionId) ?? null;
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [],
          tasks: [createSessionTask(`run-${sessionId}`, sessionId, 1, "completed", "same prompt")],
          scheduleRuns: [],
          state: {
            activeNextActions: [],
            blockedReason: null,
            currentObjective: null,
            nextAction: createNextAction(`next-${sessionId}`, sessionId, sessionId === "session-a" ? "first detail" : "second detail"),
            openCommitments: [],
            pendingDecision: null
          },
          session
        };
      }
    };
    const summary = buildHomeSummary(service);

    expect(listHomeSummaryEntries(summary).filter((entry) => entry.kind === "session")).toHaveLength(1);
  });

  it("keeps completed inbox noise off the home agenda", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createEmptyServiceStub(),
      listInbox() {
        return [
          createInbox("completed-a", "Task completed", "session-a", {
            summary: "This is a long completed task summary that should stay out of the home agenda."
          })
        ];
      }
    };
    const summary = buildHomeSummary(service);

    expect(summary.agenda).toEqual([]);
    expect(summary.actions).toMatchObject([
      {
        key: "start",
        label: "Start a task"
      }
    ]);
  });

  it("finds actionable inbox items beyond the completed items kept in the today preview", () => {
    process.env.USERNAME = "local-user";
    const completedItems = Array.from({ length: 6 }, (_, index) => ({
      ...createInbox(`completed-${index}`, "Task completed", "session-a"),
      updatedAt: `2026-01-01T0${index + 2}:00:00.000Z`
    }));
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          ...completedItems,
          {
            ...createInbox("blocked-old", "Task blocked", "session-a", {
              category: "task_blocked",
              severity: "warning",
              summary: "Need a decision before continuing."
            }),
            updatedAt: "2026-01-01T01:00:00.000Z"
          }
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeSessionId: "session-a" });

    expect(summary.agenda).not.toContain("Needs attention: Quarterly planning");
    expect(summary.actions.find((item) => item.key === "inbox")).toMatchObject({
      inboxId: "blocked-old",
      label: "Open inbox: Quarterly planning"
    });
  });

  it("humanizes provider and path errors in quick actions", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          createInbox("blocked-a", "Next action blocked", "session-a", {
            category: "task_blocked",
            severity: "warning",
            summary:
              "provider_error: xunfei response error: sid: cht000 msg: EngineInternalError; EISDIR: illegal operation on a directory, read"
          })
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeSessionId: "session-a" });
    const inboxAction = summary.actions.find((item) => item.key === "inbox");

    expect(summary.agenda).not.toContain("Needs attention: Quarterly planning");
    expect(inboxAction?.label).toBe("Open inbox: Quarterly planning");
    expect(inboxAction?.detail).toBe("Blocked: A directory was used where a file path was expected.");
  });

  it("keeps session cards on the latest run and away from completed inbox headlines", () => {
    process.env.USERNAME = "local-user";
    const session = createSession("session-card", "Card thread", "2026-01-01T04:00:00.000Z");
    const service = {
      ...createEmptyServiceStub(),
      listSessions() {
        return [session];
      },
      showSession() {
        return {
          commitments: [],
          inboxItems: [createInbox("completed-card", "Task completed", session.sessionId)],
          lineage: [],
          nextActions: [],
          tasks: [
            createSessionTask("run-old", session.sessionId, 1, "failed", "Old failure"),
            createSessionTask("run-new", session.sessionId, 2, "waiting_approval", "Latest wait")
          ],
          scheduleRuns: [],
          state: {
            activeNextActions: [],
            blockedReason: null,
            currentObjective: null,
            nextAction: null,
            openCommitments: [],
            pendingDecision: null
          },
          session
        };
      }
    };
    const sessionEntry = listHomeSummaryEntries(buildHomeSummary(service)).find((entry) => entry.kind === "session");

    expect(sessionEntry).toMatchObject({
      detail: "recent run waiting_approval",
      label: "Continue Card thread"
    });
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
            "session-a",
            "I found the old notes and can now continue. Let me prepare the full answer with the details you asked for, including the source context and the next concrete step."
          )
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeSessionId: "session-a" });

    expect(summary.agenda[0]).toBe("Continue: Wrap the planning task");
    expect(listHomeSummaryEntries(summary).find((entry) => entry.kind === "session")).toMatchObject({
      kind: "session",
      label: "Continue Wrap the planning task",
      sessionId: "session-a"
    });
  });

  it("limits the home list to the highest value entries", () => {
    process.env.USERNAME = "local-user";
    const service = {
      ...createServiceStub(),
      listInbox() {
        return [
          createInbox("inbox-action", "Decision requested", "session-a", {
            category: "decision_requested",
            severity: "action_required",
            summary: "Choose whether to publish the draft."
          })
        ];
      }
    };
    const summary = buildHomeSummary(service, { activeSessionId: "session-a" });
    const entries = listHomeSummaryEntries(summary);

    expect(entries).toHaveLength(4);
    expect(entries.map((entry) => entry.kind)).toEqual(["action", "action", "action", "session"]);
  });

  it("recommends the session with the highest-priority next action before recent history", () => {
    process.env.USERNAME = "local-user";
    const summary = buildHomeSummary(createServiceStub());
    const entries = listHomeSummaryEntries(summary);
    const firstSession = entries.find((entry) => entry.kind === "session");

    expect(summary.recentSessions.map((item) => item.label)).toEqual([
      "Release checklist",
      "Research notes",
      "Quarterly planning"
    ]);
    expect(summary.recommendedSession?.label).toBe("Quarterly planning");
    expect(firstSession).toMatchObject({
      kind: "session",
      label: "Continue Wrap the planning task",
      sessionId: "session-a"
    });
  });

  it("formats session detail with a useful preview instead of only counts", () => {
    const detail = formatSessionDetailForTui(createServiceStub() as AgentApplicationService, "session-a");

    expect(detail).toContain("Session session-a | Quarterly planning");
    expect(detail).toContain("objective: Wrap the planning task [open]");
    expect(detail).toContain("next: Draft the plan outline [pending]");
    expect(detail).toContain("recent inbox:");
    expect(detail).toContain("- Need review [pending]");
    expect(detail).toContain("recent tasks:");
    expect(detail).toContain("#2 waiting_approval | Need permission to write release notes");
    expect(detail).toContain("recent schedules:");
  });

  it("formats session selection as a conversation recap by default", () => {
    const baseService = createServiceStub();
    const service = {
      ...baseService,
      showSession(sessionId: string) {
        const detail = baseService.showSession(sessionId);
        return {
          ...detail,
          tasks: [
            createSessionTask("run-2", sessionId, 2, "succeeded", "Write the final answer", {
              finalOutput: "The final answer is ready with concise next steps."
            }),
            createSessionTask("run-1", sessionId, 1, "waiting_approval", "Need permission to write release notes")
          ],
          state: {
            ...detail.state,
            currentObjective: createCommitment("commitment-a", sessionId),
            nextAction: createNextAction("next-a", sessionId, "Review the release notes")
          }
        };
      }
    };
    const recap = formatSessionRecapForTui(service as AgentApplicationService, "session-a");

    expect(recap).toContain("Session session-a | Quarterly planning");
    expect(recap).toContain("Previous conversation:");
    expect(recap).toContain("- You: Need permission to write release notes");
    expect(recap).toContain("- You: Write the final answer");
    expect(recap).toContain("- AutoTalon: The final answer is ready with concise next steps.");
    expect(recap.indexOf("- You: Need permission to write release notes")).toBeLessThan(
      recap.indexOf("- You: Write the final answer")
    );
    expect(recap).toContain("Current focus:");
    expect(recap).toContain("- Objective: Wrap the planning task");
    expect(recap).toContain("- Next: Review the release notes");
    expect(recap).not.toContain("counts:");
    expect(recap).not.toContain("recent tasks:");
    expect(recap).not.toContain("recent schedules:");
  });

  it("omits duplicate focus lines from the session recap", () => {
    const baseService = createServiceStub();
    const service = {
      ...baseService,
      showSession(sessionId: string) {
        const session = createSession(sessionId, "鍙洖澶嶏細schedule-ok-from-feishu", "2026-01-01T02:00:00.000Z");
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [],
          tasks: [createSessionTask("run-a", sessionId, 1, "succeeded", "鍙洖澶嶏細schedule-ok-from-feishu")],
          scheduleRuns: [],
          state: {
            activeNextActions: [],
            blockedReason: null,
            currentObjective: createCommitment("commitment-a", sessionId, {
              title: "鍙洖澶嶏細schedule-ok-from-feishu"
            }),
            nextAction: null,
            openCommitments: [],
            pendingDecision: "鍙洖澶嶏細schedule-ok-from-feishu"
          },
          session
        };
      }
    };
    const recap = formatSessionRecapForTui(service as AgentApplicationService, "session-a");

    expect(recap).not.toContain("Current focus:");
    expect(recap).not.toContain("Decision needed:");
    expect(recap).not.toContain("Objective:");
  });

  it("keeps stale running runs and assistant fragments out of the recap", () => {
    const baseService = createServiceStub();
    const service = {
      ...baseService,
      showSession(sessionId: string) {
        const detail = baseService.showSession(sessionId);
        return {
          ...detail,
          tasks: [
            createSessionTask("run-2", sessionId, 2, "running", "A stale in-progress run"),
            createSessionTask("run-1", sessionId, 1, "succeeded", "Check the forecast", {
              finalOutput: "Weather status: sunny with a high of 29C."
            })
          ],
          state: {
            ...detail.state,
            currentObjective: null,
            nextAction: createNextAction("next-fragment", sessionId, "Weather status**: sunny"),
            pendingDecision: null
          }
        };
      }
    };
    const recap = formatSessionRecapForTui(service as AgentApplicationService, "session-a");

    expect(recap).toContain("- You: Check the forecast");
    expect(recap).toContain("- AutoTalon: Weather status: sunny with a high of 29C.");
    expect(recap).not.toContain("A stale in-progress run");
    expect(recap).not.toContain("Still running.");
    expect(recap).not.toContain("Current focus:");
    expect(recap).not.toContain("Weather status**");
  });

  it("keeps completed notification noise and duplicate decisions out of session details", () => {
    const baseService = createServiceStub();
    const service = {
      ...baseService,
      showSession(sessionId: string) {
        const detail = baseService.showSession(sessionId);
        return {
          ...detail,
          inboxItems: [
            createInbox("completed-a", "Task completed", "session-a"),
            createInbox("routine-a", "Routine completed: 椋炰功涓€鍒嗛挓瀹氭椂娴嬭瘯", "session-a"),
            createInbox("blocked-a", "Need review", "session-a", {
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
    const detail = formatSessionDetailForTui(service as AgentApplicationService, "session-a");

    expect(detail).not.toContain("decision: Wrap the planning task");
    expect(detail).not.toContain("Task completed [pending]");
    expect(detail).not.toContain("Routine completed: 椋炰功涓€鍒嗛挓瀹氭椂娴嬭瘯");
    expect(detail).toContain("recent inbox:");
    expect(detail).toContain("- Need review [pending]");
  });
});

function createServiceStub(): HomeServiceStub {
  const sessions = [
    createSession("session-a", "Quarterly planning", "2026-01-01T01:00:00.000Z"),
    createSession("session-b", "Release checklist", "2026-01-01T03:00:00.000Z"),
    createSession("session-c", "Research notes", "2026-01-01T02:00:00.000Z")
  ];
  const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));

  return {
    listCommitments() {
      return [createCommitment("commitment-a", "session-a")];
    },
    listInbox() {
      return [createInbox("inbox-a", "Need review", "session-a")];
    },
    listNextActions() {
      return [createNextAction("next-a", "session-a")];
    },
    listPendingApprovals() {
      return [createApproval("approval-a")];
    },
    listSchedules() {
      return [createSchedule("schedule-a", "Morning review")];
    },
    listSessions() {
      return sessions;
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
          sessionId: "session-a",
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
    showSession(sessionId) {
      const session = sessionMap.get(sessionId) ?? null;
      if (session === null) {
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [],
          tasks: [],
          scheduleRuns: [],
          state: {
            activeNextActions: [],
            blockedReason: null,
            currentObjective: null,
            nextAction: null,
            openCommitments: [],
            pendingDecision: null
          },
          session: null
        };
      }
      if (sessionId === "session-a") {
        return {
          commitments: [createCommitment("commitment-a", session.sessionId)],
          inboxItems: [createInbox("inbox-a", "Need review", session.sessionId)],
          lineage: [],
          nextActions: [createNextAction("next-a", session.sessionId)],
          tasks: [
            createSessionTask("run-2", session.sessionId, 2, "waiting_approval", "Need permission to write release notes"),
            createSessionTask("run-1", session.sessionId, 1, "completed", "Draft the quarterly plan")
          ],
          scheduleRuns: [createScheduleRun("schedule-a", session.sessionId, "waiting_approval")],
          state: {
            activeNextActions: [createNextAction("next-a", session.sessionId)],
            blockedReason: null,
            currentObjective: createCommitment("commitment-a", session.sessionId),
            nextAction: createNextAction("next-a", session.sessionId),
            openCommitments: [createCommitment("commitment-a", session.sessionId)],
            pendingDecision: null
          },
          session
        };
      }
      if (sessionId === "session-b") {
        return {
          commitments: [],
          inboxItems: [],
          lineage: [],
          nextActions: [createNextAction("next-b", session.sessionId, "Check final release blockers")],
          tasks: [createSessionTask("run-3", session.sessionId, 3, "running", "Validate RC build and changelog")],
          scheduleRuns: [],
          state: {
            activeNextActions: [createNextAction("next-b", session.sessionId, "Check final release blockers")],
            blockedReason: null,
            currentObjective: null,
            nextAction: createNextAction("next-b", session.sessionId, "Check final release blockers"),
            openCommitments: [],
            pendingDecision: null
          },
          session
        };
      }
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        tasks: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: "Waiting on experiment results",
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        session
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
    listSessions() {
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
    showSession() {
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        tasks: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: null,
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        session: null
      };
    }
  };
}

function createSession(sessionId: string, title: string, updatedAt: string): SessionRecord {
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
    title,
    updatedAt
  };
}

function createInbox(
  inboxId: string,
  title: string,
  sessionId: string,
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
    sessionId,
    title,
    updatedAt: "2026-01-01T01:00:00.000Z",
    userId: "local-user"
  };
}

function createCommitment(
  commitmentId: string,
  sessionId: string,
  overrides: Partial<Pick<CommitmentRecord, "summary" | "title">> = {}
): CommitmentRecord {
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
    summary: overrides.summary ?? "Wrap the planning task",
    taskId: null,
    sessionId,
    title: overrides.title ?? "Wrap the planning task",
    updatedAt: "2026-01-01T01:00:00.000Z"
  };
}

function createNextAction(nextActionId: string, sessionId: string, title = "Draft the plan outline"): NextActionRecord {
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
    sessionId,
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
    sessionId: null,
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createSessionTask(
  runId: string,
  sessionId: string,
  runNumber: number,
  status: SessionTaskRecord["status"],
  input: string,
  summary: SessionTaskRecord["summary"] = {}
): SessionTaskRecord {
  return {
    createdAt: `2026-01-01T0${runNumber}:00:00.000Z`,
    finishedAt: status === "completed" ? `2026-01-01T0${runNumber}:30:00.000Z` : null,
    input,
    metadata: {},
    runId,
    runNumber,
    status,
    summary,
    taskId: `task-${runNumber}`,
    sessionId
  };
}

function createScheduleRun(
  scheduleId: string,
  sessionId: string,
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
    sessionId,
    trigger: "scheduled"
  };
}



