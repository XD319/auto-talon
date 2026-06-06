import { describe, expect, it } from "vitest";

import { CommitmentCollector } from "../src/runtime/commitments/commitment-collector.js";
import { CommitmentService } from "../src/runtime/commitments/commitment-service.js";
import { NextActionService } from "../src/runtime/commitments/next-action-service.js";
import { SessionSummaryService } from "../src/runtime/context/session-summary-service.js";
import { StorageManager } from "../src/storage/database.js";
import { TraceService } from "../src/tracing/trace-service.js";

describe("commitment services", () => {
  it("emits trace events for status transitions", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        ownerUserId: "u1",
        providerName: "test-provider",
        sessionId: "session-1",
        title: "Thread one"
      });

      const traceService = new TraceService(storage.traces);
      const commitmentService = new CommitmentService({
        commitmentRepository: storage.commitments,
        traceService
      });
      const nextActionService = new NextActionService({
        nextActionRepository: storage.nextActions,
        traceService
      });

      const commitment = commitmentService.create({
        ownerUserId: "u1",
        source: "manual",
        summary: "summary",
        sessionId: "session-1",
        title: "Deliver update"
      });
      commitmentService.block(commitment.commitmentId, "blocked");
      commitmentService.unblock(commitment.commitmentId);
      const action = nextActionService.create({
        source: "manual",
        status: "active",
        sessionId: "session-1",
        title: "Run tests"
      });
      nextActionService.markDone(action.nextActionId);

      const events = storage.traces.listByTaskId(`session:session-1`);
      expect(events.some((event) => event.eventType === "commitment_created")).toBe(true);
      expect(events.some((event) => event.eventType === "commitment_blocked")).toBe(true);
      expect(events.some((event) => event.eventType === "next_action_done")).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("does not create snapshot commitments from ordinary final summaries", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        ownerUserId: "u1",
        providerName: "test-provider",
        sessionId: "session-summary",
        title: "Thread summary"
      });
      storage.tasks.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        input: "implement feature",
        maxIterations: 2,
        metadata: {},
        providerName: "test-provider",
        requesterUserId: "u1",
        status: "succeeded",
        taskId: "task-summary",
        sessionId: "session-summary",
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedCostUsd: 0,
          usedInput: 0,
          usedOutput: 0
        }
      });

      const traceService = new TraceService(storage.traces);
      const commitmentService = new CommitmentService({
        commitmentRepository: storage.commitments,
        traceService
      });
      const nextActionService = new NextActionService({
        nextActionRepository: storage.nextActions,
        traceService
      });
      const sessionSummaryService = new SessionSummaryService({
        repository: storage.sessionSummaries,
        traceService
      });
      const collector = new CommitmentCollector({
        commitmentService,
        findTask: (taskId) => storage.tasks.findById(taskId),
        nextActionService,
        sessionSummaryService,
        traceService
      });
      collector.start();

      sessionSummaryService.create({
        decisions: [],
        goal: "implement feature",
        metadata: {},
        nextActions: ["No files were changed in this run. I reviewed the implementation."],
        openLoops: [],
        summary: "final summary",
        taskId: "task-summary",
        sessionId: "session-summary",
        trigger: "final"
      });

      expect(commitmentService.list({ sessionId: "session-summary" })).toEqual([]);
      expect(nextActionService.list({ sessionId: "session-summary" })).toEqual([]);
      collector.stop();
    } finally {
      storage.close();
    }
  });
});
