import type { Provider, ProviderInput, ProviderResponse } from "../types/index.js";

export interface ProviderContractHarness {
  createAuthErrorProvider(): Provider;
  createDescribableProvider(): Provider;
  createEmptyProvider(): Provider;
  createMalformedResponseProvider(): Provider;
  createNetworkFailureProvider(maxRetries?: number): Provider;
  createRateLimitProvider(maxRetries?: number): Provider;
  createTextProvider(): Provider;
  createTimeoutProvider(maxRetries?: number): Provider;
  createToolCallProvider(): Provider;
  createUnavailableProvider(maxRetries?: number): Provider;
}

export function createProviderInput(taskInput: string): ProviderInput {
  return {
    agentProfileId: "executor",
    availableTools: [
      {
        capability: "filesystem.read",
        description: "Read files from the workspace.",
        inputSchema: {
          properties: {
            action: {
              enum: ["read_file"],
              type: "string"
            },
            path: {
              type: "string"
            }
          },
          required: ["action", "path"],
          type: "object"
        },
        name: "file_read",
        privacyLevel: "internal",
        riskLevel: "low"
      }
    ],
    iteration: 1,
    memoryContext: [],
    messages: [
      {
        content: "You are a helpful agent.",
        role: "system"
      },
      {
        content: taskInput,
        role: "user"
      }
    ],
    signal: new AbortController().signal,
    task: {
      agentProfileId: "executor",
      createdAt: new Date().toISOString(),
      currentIteration: 0,
      cwd: "D:\\workspace",
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: taskInput,
      maxIterations: 4,
      metadata: {},
      providerName: "mock",
      requesterUserId: "tester",
      startedAt: null,
      status: "running",
      taskId: "task-1",
      tokenBudget: {
        inputLimit: 8_000,
        outputLimit: 2_000,
        reservedOutput: 500,
        usedInput: 0,
        usedOutput: 0
      },
      updatedAt: new Date().toISOString()
    },
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 2_000,
      reservedOutput: 500,
      usedInput: 0,
      usedOutput: 0
    }
  };
}

export function finalResponse(message: string): ProviderResponse {
  return {
    kind: "final",
    message,
    usage: {
      inputTokens: 1,
      outputTokens: 1
    }
  };
}

export function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json"
    },
    status
  });
}

