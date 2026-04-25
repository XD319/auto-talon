import { describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit-service.js";
import { BudgetService } from "../src/runtime/budget/budget-service.js";
import { ContextCompactor } from "../src/runtime/context/context-compactor.js";
import { ThreadSessionMemoryService } from "../src/runtime/context/thread-session-memory-service.js";
import { RetrievalWorker } from "../src/runtime/workers/retrieval-worker.js";
import { SummarizerWorker } from "../src/runtime/workers/summarizer-worker.js";
import { WorkerDispatcher } from "../src/runtime/workers/worker-dispatcher.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";
import type {
  RecallPlanResult,
  RecallPlanningInput,
  TaskRecord,
  WorkerRequest
} from "../src/types/index.js";

function createTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    agentProfileId: "executor",
    createdAt: "2026-04-24T10:00:00.000Z",
    currentIteration: 1,
    cwd: "/repo",
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "run worker flow",
    maxIterations: 8,
    metadata: {},
    providerName: "mock",
    requesterUserId: "u1",
    startedAt: "2026-04-24T10:00:00.000Z",
    status: "running",
    taskId: "task-worker-1",
    threadId: "thread-worker-1",
    tokenBudget: {
      inputLimit: 10_000,
      outputLimit: 4_000,
      reservedOutput: 1_000,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: "2026-04-24T10:00:00.000Z",
    ...overrides
  };
}

function createRequest<TInput>(overrides: Partial<WorkerRequest<TInput>> = {}): WorkerRequest<TInput> {
  return {
    backoffBaseMs: 1,
    backoffMaxMs: 10,
    input: {} as TInput,
    maxAttempts: 2,
    taskId: "task-worker-1",
    threadId: "thread-worker-1",
    timeoutMs: 20,
    workerId: "worker-1",
    workerKind: "retrieval",
    ...overrides
  };
}

describe("worker dispatcher", () => {
  it("records dispatch and success traces", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const auditService = new AuditService(storage.auditLogs);
    const dispatcher = new WorkerDispatcher({ auditService, traceService });
    try {
      const result = await dispatcher.dispatch(
        createRequest<{ query: string }>({ input: { query: "hello" } }),
        (input) => Promise.resolve({ answer: input.query })
      );
      const traceTypes = traceService.listByTaskId("task-worker-1").map((event) => event.eventType);
      expect(result.status).toBe("succeeded");
      expect(traceTypes).toContain("worker_dispatched");
      expect(traceTypes).toContain("worker_succeeded");
    } finally {
      storage.close();
    }
  });

  it("records retry lifecycle on retriable worker failure", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const auditService = new AuditService(storage.auditLogs);
    const dispatcher = new WorkerDispatcher({ auditService, traceService });
    let attempts = 0;
    try {
      const result = await dispatcher.dispatch(
        createRequest<{ query: string }>({ input: { query: "hello" }, maxAttempts: 2 }),
        () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("first attempt failed");
          }
          return Promise.resolve({ attempts });
        }
      );
      const traceTypes = traceService.listByTaskId("task-worker-1").map((event) => event.eventType);
      expect(result.status).toBe("succeeded");
      expect(result.attemptNumber).toBe(2);
      expect(traceTypes).toContain("worker_retried");
    } finally {
      storage.close();
    }
  });

  it("records timeout trace and failed audit", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const auditService = new AuditService(storage.auditLogs);
    const dispatcher = new WorkerDispatcher({ auditService, traceService });
    try {
      const result = await dispatcher.dispatch(
        createRequest({ timeoutMs: 1 }),
        async () =>
          await new Promise((resolve) => {
            setTimeout(() => resolve("late"), 20);
          })
      );
      const traces = traceService.listByTaskId("task-worker-1");
      const audits = auditService.listByTaskId("task-worker-1");
      expect(result.status).toBe("timeout");
      expect(traces.some((event) => event.eventType === "worker_timeout")).toBe(true);
      expect(audits.some((event) => event.action === "worker_failed" && event.outcome === "timed_out")).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("skips worker when budget downgrade is active", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const auditService = new AuditService(storage.auditLogs);
    const budgetService = new BudgetService(
      {
        task: { softInputTokens: 1 },
        thread: { softInputTokens: 1 }
      },
      traceService,
      auditService
    );
    const dispatcher = new WorkerDispatcher({ auditService, budgetService, traceService });
    budgetService.recordUsage({
      costUsd: 0,
      mode: "balanced",
      taskId: "task-worker-1",
      threadId: "thread-worker-1",
      usage: { inputTokens: 5, outputTokens: 0 }
    });
    try {
      const result = await dispatcher.dispatch(createRequest(), () => Promise.resolve("should-not-run"));
      const workerFailed = traceService
        .listByTaskId("task-worker-1")
        .some((event) => event.eventType === "worker_failed");
      expect(result.status).toBe("skipped");
      expect(workerFailed).toBe(true);
    } finally {
      storage.close();
    }
  });
});

describe("summarizer worker", () => {
  it("creates thread session memory when compaction is triggered", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const traceService = new TraceService(storage.traces);
    const threadSessionMemoryService = new ThreadSessionMemoryService({
      repository: storage.threadSessionMemories,
      traceService
    });
    const worker = new SummarizerWorker({
      contextCompactor: new ContextCompactor(),
      threadSessionMemoryService
    });
    storage.threads.create({
      agentProfileId: "executor",
      cwd: "/repo",
      ownerUserId: "u1",
      providerName: "mock",
      threadId: "thread-worker-1",
      title: "worker thread"
    });
    const task = createTask();
    try {
      const result = await worker.execute({
        availableTools: [],
        compactInput: {
          maxMessagesBeforeCompact: 4,
          messages: [{ content: "finish this task", role: "user" }],
          reason: "message_count",
          sessionScopeKey: task.taskId,
          taskId: task.taskId
        },
        compactResult: {
          reason: "message_count",
          replacementMessages: [{ content: "summary", role: "system" }],
          summaryMemory: null,
          triggered: true
        },
        runId: null,
        task
      });
      expect(result.compacted).toBe(true);
      expect(result.sessionMemory?.threadId).toBe(task.threadId);
      expect(
        traceService.listByTaskId(task.taskId).some((event) => event.eventType === "thread_session_memory_written")
      ).toBe(true);
    } finally {
      storage.close();
    }
  });
});

describe("retrieval worker", () => {
  it("delegates to recall planner", async () => {
    const plannerResult: RecallPlanResult = {
      explain: {
        candidateCount: 0,
        enrichedQuery: "q",
        items: [],
        selectedCount: 0,
        skippedCount: 0,
        tokenBudget: 100,
        tokenUsed: 0
      },
      fragments: []
    };
    const plan = vi.fn<(_input: RecallPlanningInput) => RecallPlanResult>().mockReturnValue(plannerResult);
    const worker = new RetrievalWorker({
      recallPlanner: {
        plan
      } as never
    });
    const task = createTask();
    const result = await worker.execute({
      task,
      threadCommitmentState: null,
      tokenBudget: task.tokenBudget,
      toolPlan: []
    });
    expect(result).toEqual(plannerResult);
    expect(plan).toHaveBeenCalledTimes(1);
  });
});
