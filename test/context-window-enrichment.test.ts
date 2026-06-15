import { describe, expect, it } from "vitest";

import {
  enrichProviderContextFromApi,
  shouldFetchContextWindowFromApi
} from "../src/providers/context-window-enrichment.js";
import type { ResolvedProviderConfig } from "../src/providers/config.js";
import type { Provider } from "../src/types/index.js";

function createProviderConfig(
  overrides: Partial<ResolvedProviderConfig> = {}
): ResolvedProviderConfig {
  return {
    apiKey: "test-key",
    baseUrl: "https://example.test/v1",
    builtinProviderName: "openai",
    configPath: "/tmp/provider.config.json",
    configSource: "env",
    configured: true,
    contextWindowSource: "provider_manifest",
    contextWindowTokens: 128_000,
    displayName: "OpenAI",
    family: "openai-compatible",
    maxRetries: 1,
    model: "gpt-4o",
    name: "openai",
    streamIdleTimeoutMs: 300_000,
    timeoutConfigured: false,
    streamIdleTimeoutConfigured: false,
    timeoutMs: 5_000,
    transport: "openai-compatible",
    ...overrides
  };
}

class StubContextProvider implements Provider {
  public readonly name = "stub-provider";
  public readonly model = "stub-model";

  public constructor(private readonly tokens: number | null) {}

  public async fetchContextWindow(): Promise<number | null> {
    return this.tokens;
  }

  public async generate(): Promise<never> {
    throw new Error("not implemented");
  }
}

describe("context-window-enrichment", () => {
  it("skips API lookup when inputLimit is explicit", () => {
    expect(
      shouldFetchContextWindowFromApi(createProviderConfig(), {
        tokenBudgetInputLimitExplicit: true
      })
    ).toBe(false);
  });

  it("skips API lookup when provider config sets contextWindowTokens", () => {
    expect(
      shouldFetchContextWindowFromApi(
        createProviderConfig({ contextWindowSource: "provider_config" }),
        { tokenBudgetInputLimitExplicit: false }
      )
    ).toBe(false);
  });

  it("applies API context window when lookup succeeds", async () => {
    const enriched = await enrichProviderContextFromApi(
      new StubContextProvider(200_000),
      createProviderConfig(),
      { tokenBudgetInputLimitExplicit: false }
    );

    expect(enriched.contextWindowTokens).toBe(200_000);
    expect(enriched.contextWindowSource).toBe("provider_api");
  });

  it("keeps static context window when API lookup returns null", async () => {
    const enriched = await enrichProviderContextFromApi(
      new StubContextProvider(null),
      createProviderConfig(),
      { tokenBudgetInputLimitExplicit: false }
    );

    expect(enriched.contextWindowTokens).toBe(128_000);
    expect(enriched.contextWindowSource).toBe("provider_manifest");
  });
});
