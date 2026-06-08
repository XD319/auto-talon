import { describe, expect, it } from "vitest";

import { ExecutionContextAssembler } from "../src/runtime/context-assembler.js";
import type { AgentProfile, TaskRecord } from "../src/types/index.js";

describe("ExecutionContextAssembler", () => {
  it("describes public web fetch usage in the initial system prompt", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      createTask(),
      [
        {
          capability: "network.fetch_public_readonly",
          description: "Fetch a public URL",
          inputSchema: { type: "object" },
          name: "web_extract",
          privacyLevel: "restricted",
          riskLevel: "medium"
        }
      ],
      createProfile()
    );

    expect(messages[0]?.content).toContain("When web_extract is available");
    expect(messages[0]?.content).toContain("read public web pages");
    expect(messages[0]?.content).toContain("Visible tools may still be denied");
    expect(messages[0]?.content).toContain("Available tools: web_extract.");
  });

  it("keeps the initial system prompt concise when web fetch is unavailable", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      createTask(),
      [
        {
          capability: "filesystem.read",
          description: "Read a local file",
          inputSchema: { type: "object" },
          name: "read_file",
          privacyLevel: "internal",
          riskLevel: "low"
        }
      ],
      createProfile()
    );

    expect(messages[0]?.content).not.toContain("When web_extract is available");
    expect(messages[0]?.content).toContain("Visible tools may still be denied");
    expect(messages[0]?.content).toContain("Available tools: read_file.");
  });
});

function createProfile(): AgentProfile {
  return {
    description: "Executor profile",
    displayName: "Executor",
    id: "executor",
    systemPrompt: "You are a coding agent."
  };
}

function createTask(): TaskRecord {
  const now = new Date().toISOString();
  return {
    agentProfileId: "executor",
    createdAt: now,
    currentIteration: 0,
    cwd: process.cwd(),
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "check today's weather in New York",
    maxIterations: 4,
    metadata: {},
    providerName: "test-provider",
    requesterUserId: "user-1",
    startedAt: now,
    status: "running",
    taskId: "task-context-1",
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
