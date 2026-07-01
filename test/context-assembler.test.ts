import { describe, expect, it } from "vitest";

import {
  ExecutionContextAssembler,
  MEMORY_CONTEXT_SOURCE_TYPE,
  mergeMemoryContextIntoMessages
} from "../src/runtime/context-assembler.js";
import type { AgentProfile, ContextFragment, TaskRecord } from "../src/types/index.js";

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

  it("injects full web_search unavailability guidance whenever web_search is unavailable", () => {
    const assembler = new ExecutionContextAssembler();
    const messages = assembler.buildInitialMessages(
      {
        ...createTask(),
        input: "search web for skills and mcp differences"
      },
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
      createProfile(),
      undefined,
      [
        {
          exposed: false,
          reason: "unavailable: web_search backend is disabled",
          toolName: "web_search"
        }
      ]
    );

    expect(messages[0]?.content).toContain("web_search is unavailable: web_search backend is disabled");
    expect(messages[0]?.content).toContain("Do not answer from general knowledge");
    expect(messages[0]?.content).toContain("FIRECRAWL_API_KEY");
    expect(messages[0]?.content).toContain("cannot discover search results");
  });

  it("merges memoryContext recall fragments into provider messages", () => {
    const assembler = new ExecutionContextAssembler();
    const fragments = [createMemoryFragment()];
    const assembled = assembler.assemble({
      availableTools: [],
      iteration: 1,
      memoryContext: fragments,
      messages: [
        {
          content: "You are a coding agent.",
          metadata: {
            privacyLevel: "internal",
            retentionKind: "working",
            sourceType: "system_prompt"
          },
          role: "system"
        },
        {
          content: "fix the bug",
          metadata: {
            privacyLevel: "internal",
            retentionKind: "working",
            sourceType: "user_input"
          },
          role: "user"
        }
      ],
      signal: new AbortController().signal,
      task: createTask(),
      tokenBudget: createTask().tokenBudget
    });

    const recalledMessage = assembled.providerInput.messages.find(
      (message) => message.metadata?.sourceType === MEMORY_CONTEXT_SOURCE_TYPE
    );
    expect(recalledMessage?.role).toBe("system");
    expect(recalledMessage?.content).toContain("Recalled context:");
    expect(recalledMessage?.content).toContain("Use pnpm for verification");
    expect(assembled.memoryContextInjection?.fragmentCount).toBe(1);
    expect(typeof assembled.memoryContextInjection?.tokenEstimate).toBe("number");
    expect(assembled.providerInput.memoryContext).toEqual(fragments);
  });

  it("replaces an existing recalled-context message on re-assembly", () => {
    const existing = mergeMemoryContextIntoMessages(
      [
        {
          content: "system",
          role: "system"
        }
      ],
      [createMemoryFragment()]
    ).messages;
    const next = mergeMemoryContextIntoMessages(existing, [
      {
        ...createMemoryFragment(),
        text: "Updated recall text"
      }
    ]);

    const recalledMessages = next.messages.filter(
      (message) => message.metadata?.sourceType === MEMORY_CONTEXT_SOURCE_TYPE
    );
    expect(recalledMessages).toHaveLength(1);
    expect(recalledMessages[0]?.content).toContain("Updated recall text");
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

function createMemoryFragment(): ContextFragment {
  return {
    confidence: 0.9,
    memoryId: "memory:project:smoke",
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "project",
      reason: "Project memory",
      ttlDays: null
    },
    scope: "project",
    status: "active",
    text: "Use pnpm for verification",
    title: "Smoke verification"
  };
}
