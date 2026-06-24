import { afterEach, describe, expect, it, vi } from "vitest";

import * as providerConfig from "../src/providers/config.js";
import {
  createAuxiliaryProviderResolver,
  normalizeAuxiliaryConfig
} from "../src/providers/auxiliary-resolver.js";
import type { Provider, ProviderGenerateInput, ProviderGenerateResponse } from "../src/types/index.js";

class StubProvider implements Provider {
  public constructor(
    public readonly name: string,
    public readonly model: string | null
  ) {}

  public async generate(_input: ProviderGenerateInput): Promise<ProviderGenerateResponse> {
    return { kind: "final", message: "ok" };
  }
}

describe("auxiliary resolver", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes auto and explicit selections", () => {
    expect(
      normalizeAuxiliaryConfig({
        compression: "openai:gpt-4o-mini",
        summarize: "auto",
        vision: ""
      })
    ).toEqual({
      classify: "auto",
      compression: "openai:gpt-4o-mini",
      recallRank: "auto",
      summarize: "auto",
      title: "auto",
      vision: "auto"
    });
  });

  it("uses createProvider for explicit auxiliary slots", () => {
    const mainProvider = new StubProvider("mock", "mock-model");
    const helperProvider = new StubProvider("helper", "helper-model");
    const mainProviderRef = { current: mainProvider };
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
      displayName: "Helper",
      family: "openai-compatible",
      maxRetries: 2,
      model: "helper-model",
      name: "helper",
      streamIdleTimeoutConfigured: false,
      streamIdleTimeoutMs: 300_000,
      timeoutConfigured: false,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });
    const resolver = createAuxiliaryProviderResolver({
      auxiliary: normalizeAuxiliaryConfig({
        compression: "helper:helper-model"
      }),
      createProvider: () => helperProvider,
      cwd: process.cwd(),
      mainProviderRef
    });

    const resolved = resolver.resolve("compression", { sessionId: null, taskId: "task-1" });
    expect(resolved).toBe(helperProvider);
  });

  it("falls back to main provider for auto slots", () => {
    const mainProvider = new StubProvider("mock", "mock-model");
    const mainProviderRef = { current: mainProvider };
    const resolver = createAuxiliaryProviderResolver({
      auxiliary: normalizeAuxiliaryConfig({}),
      createProvider: () => mainProvider,
      cwd: process.cwd(),
      mainProviderRef
    });

    expect(resolver.resolve("summarize", { sessionId: null, taskId: "task-1" }).name).toBe("mock");
  });

  it("uses setMainProvider and clearProviderCache after a model switch", () => {
    const initialMain = new StubProvider("mock", "mock-model");
    const switchedMain = new StubProvider("vendor-b", "vendor-b-model");
    const cachedHelper = new StubProvider("helper", "helper-model");
    const mainProviderRef = { current: initialMain };
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
      displayName: "Helper",
      family: "openai-compatible",
      maxRetries: 2,
      model: "helper-model",
      name: "helper",
      streamIdleTimeoutConfigured: false,
      streamIdleTimeoutMs: 300_000,
      timeoutConfigured: false,
      timeoutMs: 120_000,
      transport: "openai-compatible"
    });
    const resolver = createAuxiliaryProviderResolver({
      auxiliary: normalizeAuxiliaryConfig({ compression: "helper:helper-model" }),
      createProvider: () => cachedHelper,
      cwd: process.cwd(),
      mainProviderRef
    });

    expect(resolver.resolve("compression", { sessionId: null, taskId: "task-1" })).toBe(cachedHelper);
    resolver.setMainProvider(switchedMain);
    expect(resolver.resolve("summarize", { sessionId: null, taskId: "task-1" }).name).toBe("vendor-b");
    resolver.clearProviderCache();
    const afterClear = resolver.resolve("compression", { sessionId: null, taskId: "task-1" });
    expect(afterClear).toBe(cachedHelper);
  });
});
