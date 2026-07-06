import { describe, expect, it } from "vitest";

import { SessionStateProjector } from "../src/runtime/sessions/session-state-projector.js";
import type { SessionCommitmentState, SessionMessageRecord } from "../src/types/index.js";

const emptyCommitmentState: SessionCommitmentState = {
  activeNextActions: [],
  blockedReason: null,
  currentObjective: null,
  nextAction: null,
  openCommitments: [],
  pendingDecision: null
};

function createUserMessage(sessionId: string, text: string): SessionMessageRecord {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    entrySource: "tui",
    kind: "user",
    messageId: "user:1",
    payload: { id: "user:1", kind: "user", text, timestamp: "2026-01-01T00:00:00.000Z" },
    sequence: 1,
    sessionId
  };
}

describe("SessionStateProjector", () => {
  it("includes recent conversation tail when no session summary exists", () => {
    const sessionId = "session-no-summary";
    const projector = new SessionStateProjector({
      commitmentProjector: {
        project: () => emptyCommitmentState
      },
      sessionMessageRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => [createUserMessage(sessionId, "Remember this prior request")],
        replaceAll: () => {
          throw new Error("not used");
        }
      },
      sessionSummaryService: {
        create: () => {
          throw new Error("not used");
        },
        findById: () => null,
        findLatestBySession: () => null,
        listBySession: () => []
      },
      sessionTranscriptRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => []
      }
    });

    const projection = projector.projectState(sessionId);
    expect(projection.sessionSummary).toBeNull();
    expect(projection.messages.some((message) => message.role === "user" && message.content.includes("Remember"))).toBe(
      true
    );
  });

  it("includes commitment resume messages when no session summary exists", () => {
    const sessionId = "session-commitment-only";
    const projector = new SessionStateProjector({
      commitmentProjector: {
        project: () => ({
          ...emptyCommitmentState,
          nextAction: {
            blockedReason: null,
            commitmentId: null,
            completedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            detail: null,
            dueAt: null,
            metadata: {},
            nextActionId: "next-1",
            rank: 1,
            sessionId,
            source: "agent",
            sourceTaskId: null,
            sourceTraceId: null,
            status: "active",
            taskId: null,
            title: "Finish compaction tests",
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        })
      },
      sessionMessageRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => [],
        replaceAll: () => {
          throw new Error("not used");
        }
      },
      sessionSummaryService: {
        create: () => {
          throw new Error("not used");
        },
        findById: () => null,
        findLatestBySession: () => null,
        listBySession: () => []
      },
      sessionTranscriptRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => []
      }
    });

    const projection = projector.projectState(sessionId);
    expect(
      projection.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.startsWith("KnownPlannedNextAction:") &&
          message.content.includes("Finish compaction tests")
      )
    ).toBe(true);
  });

  it("includes recent user tail when a session summary exists", () => {
    const sessionId = "session-with-summary";
    const projector = new SessionStateProjector({
      commitmentProjector: {
        project: () => emptyCommitmentState
      },
      sessionMessageRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => [
          createUserMessage(sessionId, "older request"),
          createUserMessage(sessionId, "latest pinned request")
        ],
        replaceAll: () => {
          throw new Error("not used");
        }
      },
      sessionSummaryService: {
        create: () => {
          throw new Error("not used");
        },
        findById: () => null,
        findLatestBySession: () => ({
          createdAt: "2026-01-01T00:00:00.000Z",
          decisions: [],
          goal: "latest pinned request",
          metadata: {},
          nextActions: [],
          openLoops: [],
          runId: "run-1",
          sessionId,
          sessionSummaryId: "summary-1",
          summary: "goal=latest pinned request",
          taskId: "task-1",
          trigger: "final"
        }),
        listBySession: () => []
      },
      sessionTranscriptRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => []
      }
    });

    const projection = projector.projectState(sessionId);
    expect(
      projection.messages.some(
        (message) => message.role === "system" && message.content.startsWith("KnownActiveGoal:")
      )
    ).toBe(true);
    expect(
      projection.messages.some(
        (message) => message.role === "user" && message.content.includes("latest pinned request")
      )
    ).toBe(true);
  });

  it("does not inject noisy feature backlog on resume", () => {
    const sessionId = "session-noisy-backlog";
    const projector = new SessionStateProjector({
      commitmentProjector: {
        project: () => emptyCommitmentState
      },
      sessionMessageRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => [],
        replaceAll: () => {
          throw new Error("not used");
        }
      },
      sessionSummaryService: {
        create: () => {
          throw new Error("not used");
        },
        findById: () => null,
        findLatestBySession: () => ({
          createdAt: "2026-01-01T00:00:00.000Z",
          decisions: [],
          goal: "continue refactor",
          metadata: {
            featureBacklog: [{ name: "this.config = config", source: "agent", status: "pending" }]
          },
          nextActions: [],
          openLoops: [],
          runId: "run-1",
          sessionId,
          sessionSummaryId: "summary-1",
          summary: "goal=continue refactor",
          taskId: "task-1",
          trigger: "compact"
        }),
        listBySession: () => []
      },
      sessionTranscriptRepository: {
        append: () => {
          throw new Error("not used");
        },
        listBySessionId: () => []
      }
    });

    const projection = projector.projectState(sessionId);
    expect(
      projection.messages.some((message) => message.content.startsWith("KnownFeatureBacklog:"))
    ).toBe(false);
  });
});
