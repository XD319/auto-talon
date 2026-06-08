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
      sessionSummaryService: {
        create(draft: SessionSummaryDraft): SessionSummaryRecord {
          capturedDraft = draft;
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
        }
      } as unknown as SessionSummaryService
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
});

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
