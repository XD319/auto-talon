import { describe, expect, it } from "vitest";

import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import { SummarizerWorker } from "../src/runtime/workers/summarizer-worker.js";
import type { SessionSummaryService } from "../src/runtime/context/index.js";
import type {
  ProviderToolDescriptor,
  TaskRecord,
  SessionSummaryDraft,
  SessionSummaryRecord
} from "../src/types/index.js";

describe("SummarizerWorker", () => {
  it("persists compact reason and replaced message count through worker compaction", async () => {
    let capturedDraft: SessionSummaryDraft | null = null;
    const worker = new SummarizerWorker({
      contextCompactor: new ContextCompactor(),
      sessionSummaryService: createSessionSummaryService((draft) => {
        capturedDraft = draft;
      })
    });

    await worker.execute({
      availableTools: [createToolDescriptor("read_file")],
      compactInput: {
        maxMessagesBeforeCompact: 4,
        messages: [
          { content: "system", role: "system" },
          { content: "implement feature", role: "user" },
          { content: "read file", role: "assistant" },
          { content: "tool output", role: "tool", toolCallId: "read-1", toolName: "read_file" },
          { content: "summary", role: "assistant" }
        ],
        reason: "tool_call_count",
        sessionScopeKey: "session-1",
        taskId: "task-1"
      },
      compactResult: {
        reason: "tool_call_count",
        replacementMessages: [
          { content: "Session summary", role: "system" },
          { content: "summary", role: "assistant" }
        ],
        summaryMemory: null,
        triggered: true
      },
      runId: "run-1",
      task: createTask()
    });

    expect(capturedDraft?.metadata).toMatchObject({
      compactReason: "tool_call_count",
      replacedMessageCount: 3
    });
  });

  it("merges previous session summary continuity on the success path", async () => {
    let capturedDraft: SessionSummaryDraft | null = null;
    const previousSummary: SessionSummaryRecord = {
      createdAt: "2026-01-01T00:00:00.000Z",
      decisions: ["use PostgreSQL"],
      goal: "Design persistence layer",
      metadata: {},
      nextActions: ["verify follow-up output"],
      openLoops: ["pending read_file (tc-prev)"],
      runId: null,
      sessionSummaryId: "summary-before-compact",
      summary: "previous summary",
      taskId: "task-initial",
      sessionId: "session-1",
      trigger: "compact"
    };
    const worker = new SummarizerWorker({
      contextCompactor: new ContextCompactor(),
      sessionSummaryService: {
        ...createSessionSummaryService((draft: SessionSummaryDraft) => {
          capturedDraft = draft;
        }),
        findLatestBySession: () => previousSummary
      } as unknown as SessionSummaryService
    });

    await worker.execute({
      availableTools: [],
      compactInput: {
        maxMessagesBeforeCompact: 2,
        messages: [
          { content: "What is the current status?", role: "user" },
          { content: "Decision: keep the migration reversible", role: "assistant" }
        ],
        reason: "context_budget",
        sessionScopeKey: "session-1",
        taskId: "task-follow-up"
      },
      compactResult: {
        reason: "context_budget",
        replacementMessages: [{ content: "summary", role: "assistant" }],
        summaryMemory: null,
        triggered: true
      },
      runId: "run-1",
      task: createTask()
    });

    expect(capturedDraft).not.toBeNull();
    const draft = capturedDraft as SessionSummaryDraft;
    expect(draft.goal).toBe("What is the current status?");
    expect(draft.decisions).toEqual(["use PostgreSQL", "keep the migration reversible"]);
    expect(draft.openLoops.join(" ")).toContain("tc-prev");
    expect(draft.nextActions).toEqual([]);
    expect(
      (draft.metadata as { previousSessionSummaryId?: string }).previousSessionSummaryId
    ).toBe("summary-before-compact");
  });
});

function createSessionSummaryService(
  onCreate: (draft: SessionSummaryDraft) => void
): SessionSummaryService {
  return {
    create(draft: SessionSummaryDraft): SessionSummaryRecord {
      onCreate(draft);
      return {
        createdAt: "2026-01-01T00:00:00.000Z",
        decisions: draft.decisions,
        goal: draft.goal,
        metadata: draft.metadata ?? {},
        nextActions: draft.nextActions,
        openLoops: draft.openLoops,
        runId: draft.runId ?? null,
        sessionSummaryId: "session-memory-1",
        summary: draft.summary,
        taskId: draft.taskId ?? null,
        sessionId: draft.sessionId,
        trigger: draft.trigger
      };
    },
    findLatestBySession: () => null
  } as unknown as SessionSummaryService;
}

function createTask(): TaskRecord {
  return {
    agentProfileId: "executor",
    createdAt: "2026-01-01T00:00:00.000Z",
    currentIteration: 1,
    cwd: "/workspace",
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "implement feature",
    maxIterations: 10,
    metadata: {},
    providerName: "mock",
    requesterUserId: "user",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    taskId: "task-1",
    sessionId: "session-1",
    tokenBudget: {
      maxCostUsd: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 1000
    },
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createToolDescriptor(name: string): ProviderToolDescriptor {
  return {
    capability: "filesystem.read",
    description: name,
    inputSchema: { type: "object" },
    name,
    privacyLevel: "internal",
    riskLevel: "low"
  };
}
