import { afterEach, describe, expect, it, vi } from "vitest";

import * as providerConfig from "../src/providers/config.js";
import * as providerFactory from "../src/providers/provider-factory.js";
import { ProviderError } from "../src/providers/provider-error.js";
import { generateWithProviderFailover, clearFallbackProviderCache } from "../src/providers/provider-failover.js";
import type { Provider, ProviderGenerateInput, ProviderGenerateResponse } from "../src/types/index.js";

class StubProvider implements Provider {
  public attempts = 0;

  public constructor(
    public readonly name: string,
    public readonly model: string | null,
    private readonly behavior: () => Promise<ProviderGenerateResponse>
  ) {}

  public async generate(_input: ProviderGenerateInput): Promise<ProviderGenerateResponse> {
    this.attempts += 1;
    return this.behavior();
  }
}

describe("provider failover", () => {
  afterEach(() => {
    clearFallbackProviderCache();
    vi.restoreAllMocks();
  });

  it("retries with fallback provider on retriable errors", async () => {
    const primary = new StubProvider("primary", "primary-model", async () => {
      throw new ProviderError({
        category: "rate_limit",
        message: "rate limited",
        modelName: "primary-model",
        providerName: "primary"
      });
    });
    const fallback = new StubProvider("fallback", "fallback-model", async () => ({
      kind: "final",
      message: "ok"
    }));

    vi.spyOn(providerConfig, "resolveMergedFallbackProviders").mockReturnValue([
      "fallback:fallback-model"
    ]);
    vi.spyOn(providerConfig, "resolveProviderSelectionWithAliases").mockImplementation(
      (selection) => selection
    );
    vi.spyOn(providerConfig, "resolveProviderConfigForProvider").mockReturnValue({
      apiKey: "key",
      baseUrl: null,
      builtinProviderName: null,
      configPath: "/tmp/provider.config.json",
      configSource: "user",
      configured: true,
      contextWindowSource: null,
      contextWindowTokens: 64_000,
      displayName: "Fallback",
      family: "openai-compatible",
      maxRetries: 2,
      model: "fallback-model",
      name: "fallback",
      streamIdleTimeoutConfigured: false,
      streamIdleTimeoutMs: 300_000,
      timeoutConfigured: false,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });
    vi.spyOn(providerFactory, "createProvider").mockReturnValue(fallback);

    const response = await generateWithProviderFailover(
      {
        cwd: process.cwd(),
        enableFailover: true,
        primaryProvider: primary,
        taskId: "task-1"
      },
      {
        agentProfileId: "executor",
        availableTools: [],
        iteration: 1,
        memoryContext: [],
        messages: [],
        signal: new AbortController().signal,
        task: {
          agentProfileId: "executor",
          createdAt: "",
          currentIteration: 1,
          cwd: "",
          errorCode: null,
          errorMessage: null,
          finalOutput: null,
          finishedAt: null,
          input: "hello",
          maxIterations: 1,
          metadata: {},
          providerName: "primary",
          requesterUserId: "user",
          startedAt: null,
          status: "running",
          taskId: "task-1",
          sessionId: null,
          tokenBudget: {
            inputLimit: 1000,
            outputLimit: 1000,
            reservedOutput: 100,
            usedCostUsd: 0,
            usedInput: 0,
            usedOutput: 0
          },
          updatedAt: ""
        },
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedCostUsd: 0,
          usedInput: 0,
          usedOutput: 0
        }
      }
    );

    expect(response.kind).toBe("final");
    expect(primary.attempts).toBe(1);
    expect(fallback.attempts).toBe(1);
  });

  it("throws when all candidates fail", async () => {
    const primary = new StubProvider("primary", "primary-model", async () => {
      throw new ProviderError({
        category: "rate_limit",
        message: "rate limited",
        modelName: "primary-model",
        providerName: "primary"
      });
    });
    const fallback = new StubProvider("fallback", "fallback-model", async () => {
      throw new ProviderError({
        category: "server_error",
        message: "server down",
        modelName: "fallback-model",
        providerName: "fallback"
      });
    });

    vi.spyOn(providerConfig, "resolveMergedFallbackProviders").mockReturnValue([
      "fallback:fallback-model"
    ]);
    vi.spyOn(providerConfig, "resolveProviderSelectionWithAliases").mockImplementation(
      (selection) => selection
    );
    vi.spyOn(providerConfig, "resolveProviderConfigForProvider").mockReturnValue({
      apiKey: "key",
      baseUrl: null,
      builtinProviderName: null,
      configPath: "/tmp/provider.config.json",
      configSource: "user",
      configured: true,
      contextWindowSource: null,
      contextWindowTokens: 64_000,
      displayName: "Fallback",
      family: "openai-compatible",
      maxRetries: 2,
      model: "fallback-model",
      name: "fallback",
      streamIdleTimeoutConfigured: false,
      streamIdleTimeoutMs: 300_000,
      timeoutConfigured: false,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });
    vi.spyOn(providerFactory, "createProvider").mockReturnValue(fallback);

    await expect(
      generateWithProviderFailover(
        {
          cwd: process.cwd(),
          enableFailover: true,
          primaryProvider: primary,
          taskId: "task-1"
        },
        {
          agentProfileId: "executor",
          availableTools: [],
          iteration: 1,
          memoryContext: [],
          messages: [],
          signal: new AbortController().signal,
          task: {
            agentProfileId: "executor",
            createdAt: "",
            currentIteration: 1,
            cwd: "",
            errorCode: null,
            errorMessage: null,
            finalOutput: null,
            finishedAt: null,
            input: "hello",
            maxIterations: 1,
            metadata: {},
            providerName: "primary",
            requesterUserId: "user",
            startedAt: null,
            status: "running",
            taskId: "task-1",
            sessionId: null,
            tokenBudget: {
              inputLimit: 1000,
              outputLimit: 1000,
              reservedOutput: 100,
              usedCostUsd: 0,
              usedInput: 0,
              usedOutput: 0
            },
            updatedAt: ""
          },
          tokenBudget: {
            inputLimit: 1000,
            outputLimit: 1000,
            reservedOutput: 100,
            usedCostUsd: 0,
            usedInput: 0,
            usedOutput: 0
          }
        }
      )
    ).rejects.toMatchObject({ category: "server_error" });
  });

  it("does not retry on non-failover errors", async () => {
    const primary = new StubProvider("primary", "primary-model", async () => {
      throw new ProviderError({
        category: "invalid_request",
        message: "bad request",
        modelName: "primary-model",
        providerName: "primary"
      });
    });
    const fallback = new StubProvider("fallback", "fallback-model", async () => ({
      kind: "final",
      message: "ok"
    }));

    vi.spyOn(providerConfig, "resolveMergedFallbackProviders").mockReturnValue([
      "fallback:fallback-model"
    ]);
    vi.spyOn(providerConfig, "resolveProviderSelectionWithAliases").mockImplementation(
      (selection) => selection
    );
    vi.spyOn(providerConfig, "resolveProviderConfigForProvider").mockReturnValue({
      apiKey: "key",
      baseUrl: null,
      builtinProviderName: null,
      configPath: "/tmp/provider.config.json",
      configSource: "user",
      configured: true,
      contextWindowSource: null,
      contextWindowTokens: 64_000,
      displayName: "Fallback",
      family: "openai-compatible",
      maxRetries: 2,
      model: "fallback-model",
      name: "fallback",
      streamIdleTimeoutConfigured: false,
      streamIdleTimeoutMs: 300_000,
      timeoutConfigured: false,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });
    vi.spyOn(providerFactory, "createProvider").mockReturnValue(fallback);

    await expect(
      generateWithProviderFailover(
        {
          cwd: process.cwd(),
          enableFailover: true,
          primaryProvider: primary,
          taskId: "task-1"
        },
        {
          agentProfileId: "executor",
          availableTools: [],
          iteration: 1,
          memoryContext: [],
          messages: [],
          signal: new AbortController().signal,
          task: {
            agentProfileId: "executor",
            createdAt: "",
            currentIteration: 1,
            cwd: "",
            errorCode: null,
            errorMessage: null,
            finalOutput: null,
            finishedAt: null,
            input: "hello",
            maxIterations: 1,
            metadata: {},
            providerName: "primary",
            requesterUserId: "user",
            startedAt: null,
            status: "running",
            taskId: "task-1",
            sessionId: null,
            tokenBudget: {
              inputLimit: 1000,
              outputLimit: 1000,
              reservedOutput: 100,
              usedCostUsd: 0,
              usedInput: 0,
              usedOutput: 0
            },
            updatedAt: ""
          },
          tokenBudget: {
            inputLimit: 1000,
            outputLimit: 1000,
            reservedOutput: 100,
            usedCostUsd: 0,
            usedInput: 0,
            usedOutput: 0
          }
        }
      )
    ).rejects.toMatchObject({ category: "invalid_request" });
    expect(fallback.attempts).toBe(0);
  });

  it("skips unconfigured fallback providers and duplicate provider names", async () => {
    const primary = new StubProvider("primary", "primary-model", async () => {
      throw new ProviderError({
        category: "rate_limit",
        message: "rate limited",
        modelName: "primary-model",
        providerName: "primary"
      });
    });
    const fallback = new StubProvider("fallback", "fallback-model", async () => ({
      kind: "final",
      message: "ok"
    }));

    vi.spyOn(providerConfig, "resolveMergedFallbackProviders").mockReturnValue([
      "primary:other-model",
      "unconfigured:missing",
      "fallback:fallback-model"
    ]);
    vi.spyOn(providerConfig, "resolveProviderSelectionWithAliases").mockImplementation(
      (selection) => selection
    );
    vi.spyOn(providerConfig, "resolveProviderConfigForProvider").mockImplementation((_cwd, selection) => {
      if (selection.startsWith("unconfigured")) {
        return {
          apiKey: null,
          baseUrl: null,
          builtinProviderName: "openai",
          configPath: "/tmp/provider.config.json",
          configSource: "user",
          configured: false,
          contextWindowSource: null,
          contextWindowTokens: null,
          displayName: "Unconfigured",
          family: "openai-compatible",
          maxRetries: 2,
          model: "missing",
          name: "unconfigured",
          streamIdleTimeoutConfigured: false,
          streamIdleTimeoutMs: 300_000,
          timeoutConfigured: false,
          timeoutMs: 120_000,
          transport: "openai-compatible"
        };
      }
      return {
        apiKey: "key",
        baseUrl: null,
        builtinProviderName: null,
        configPath: "/tmp/provider.config.json",
        configSource: "user",
        configured: true,
        contextWindowSource: null,
        contextWindowTokens: 64_000,
        displayName: "Fallback",
        family: "openai-compatible",
        maxRetries: 2,
        model: selection.includes("fallback") ? "fallback-model" : "other-model",
        name: selection.startsWith("fallback") ? "fallback" : "primary",
        streamIdleTimeoutConfigured: false,
        streamIdleTimeoutMs: 300_000,
        timeoutConfigured: false,
        timeoutMs: 120_000,
        transport: "openai-compatible"
      };
    });
    vi.spyOn(providerFactory, "createProvider").mockReturnValue(fallback);

    const response = await generateWithProviderFailover(
      {
        cwd: process.cwd(),
        enableFailover: true,
        primaryProvider: primary,
        taskId: "task-1"
      },
      {
        agentProfileId: "executor",
        availableTools: [],
        iteration: 1,
        memoryContext: [],
        messages: [],
        signal: new AbortController().signal,
        task: {
          agentProfileId: "executor",
          createdAt: "",
          currentIteration: 1,
          cwd: "",
          errorCode: null,
          errorMessage: null,
          finalOutput: null,
          finishedAt: null,
          input: "hello",
          maxIterations: 1,
          metadata: {},
          providerName: "primary",
          requesterUserId: "user",
          startedAt: null,
          status: "running",
          taskId: "task-1",
          sessionId: null,
          tokenBudget: {
            inputLimit: 1000,
            outputLimit: 1000,
            reservedOutput: 100,
            usedCostUsd: 0,
            usedInput: 0,
            usedOutput: 0
          },
          updatedAt: ""
        },
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedCostUsd: 0,
          usedInput: 0,
          usedOutput: 0
        }
      }
    );

    expect(response.kind).toBe("final");
    expect(fallback.attempts).toBe(1);
  });
});
