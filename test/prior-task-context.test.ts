import { describe, expect, it } from "vitest";

import {
  PRIOR_TASK_RESULT_SOURCE_TYPE,
  buildPriorTaskContextMessage,
  truncatePriorTaskOutput
} from "../src/runtime/sessions/prior-task-context.js";
import type { SessionTaskRecord, TaskRecord } from "../src/types/index.js";

describe("prior task context", () => {
  it("builds a prior task result message from the latest session task", () => {
    const message = buildPriorTaskContextMessage({
      sessionId: "session-1",
      sessionTaskRepository: {
        create: () => {
          throw new Error("not used");
        },
        findByTaskId: () => null,
        findLatestBySessionId: () => createSessionTask(),
        listBySessionId: () => [createSessionTask()]
      },
      taskRepository: {
        create: () => {
          throw new Error("not used");
        },
        findById: () => createTask("Critical bug: null pointer in auth.ts"),
        update: () => {
          throw new Error("not used");
        }
      },
      tokenBudget: {
        inputLimit: 8_000,
        outputLimit: 2_000,
        reservedOutput: 500,
        usedInput: 0,
        usedOutput: 0
      }
    });

    expect(message?.metadata?.sourceType).toBe(PRIOR_TASK_RESULT_SOURCE_TYPE);
    expect(message?.content).toContain("PriorTaskResult:");
    expect(message?.content).toContain("Critical bug: null pointer in auth.ts");
  });

  it("truncates oversized prior task output to a token budget", () => {
    const output = "x".repeat(20_000);
    const truncated = truncatePriorTaskOutput(output, {
      inputLimit: 2_000,
      outputLimit: 500,
      reservedOutput: 200,
      usedInput: 0,
      usedOutput: 0
    });
    expect(truncated.length).toBeLessThan(output.length);
    expect(truncated).toContain("...[prior task output truncated]");
  });
});

function createSessionTask(): SessionTaskRecord {
  return {
    createdAt: "2026-06-26T00:00:00.000Z",
    finishedAt: "2026-06-26T00:05:00.000Z",
    input: "list bugs",
    metadata: {},
    runId: "run-1",
    runNumber: 1,
    sessionId: "session-1",
    status: "completed",
    summary: {},
    taskId: "task-1"
  };
}

function createTask(finalOutput: string): TaskRecord {
  const now = "2026-06-26T00:05:00.000Z";
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 1,
    cwd: process.cwd(),
    errorCode: null,
    errorMessage: null,
    finalOutput,
    finishedAt: now,
    input: "list bugs",
    maxIterations: 4,
    metadata: {},
    providerName: "test-provider",
    requesterUserId: "user-1",
    sessionId: "session-1",
    startedAt: now,
    status: "completed",
    taskId: "task-1",
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: now
  };
}
