import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicCompatibleProvider,
  GlmProvider,
  ManagedProvider,
  MockProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  createProvider,
  classifyProviderHttpError
} from "../src/providers/index.js";
import { listProviderManifests, resolveDefaultProviderSettings } from "../src/providers/provider-registry.js";
import {
  createProviderInput,
  finalResponse,
  jsonResponse,
  type ProviderContractHarness
} from "../src/testing/provider-contract-harness.js";
import type { Provider, ProviderConfig, ProviderResponse } from "../src/types/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Provider contract tests", () => {
  runProviderContractSuite("mock provider", createMockHarness());
  runProviderContractSuite("glm provider mapping", createGlmHarness());
  runProviderContractSuite("openai-compatible provider mapping", createOpenAiCompatibleHarness());
  runProviderContractSuite("anthropic provider mapping", createAnthropicHarness());
  runProviderContractSuite("minimax anthropic-compatible mapping", createMiniMaxHarness());
});

describe("Provider runtime safeguards", () => {
  it("classifies provider HTTP errors into the unified taxonomy", () => {
    expect(classifyProviderHttpError(401, "authentication_error")).toBe("auth_error");
    expect(classifyProviderHttpError(429, "rate_limit")).toBe("rate_limit");
    expect(classifyProviderHttpError(408, "timeout")).toBe("timeout_error");
    expect(classifyProviderHttpError(503, "service_unavailable")).toBe("provider_unavailable");
    expect(classifyProviderHttpError(501, "unsupported_feature")).toBe("unsupported_capability");
    expect(classifyProviderHttpError(400, "invalid_request_error")).toBe("invalid_request");
  });

  it("retries retriable provider errors", async () => {
    let attempts = 0;
    const provider = new ManagedProvider(
      new MockProvider({}, () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("socket reset");
        }

        return finalResponse("recovered");
      }),
      {
        maxRetries: 2
      } as Pick<ProviderConfig, "maxRetries">
    );

    const response = await provider.generate(createProviderInput("recover"));

    expect(response.kind).toBe("final");
    expect(response.metadata?.retryCount).toBe(2);
    expect(attempts).toBe(3);
  });

  it("does not retry non-retriable provider errors", async () => {
    let attempts = 0;
    const provider = new ManagedProvider(
      new MockProvider({}, () => {
        attempts += 1;
        throw new ProviderError({
          category: "auth_error",
          message: "bad key",
          providerName: "mock",
          retriable: false,
          summary: "Authentication failed."
        });
      }),
      {
        maxRetries: 3
      } as Pick<ProviderConfig, "maxRetries">
    );

    await expect(provider.generate(createProviderInput("fail"))).rejects.toMatchObject({
      category: "auth_error",
      retryCount: 0
    });
    expect(attempts).toBe(1);
  });

  it("recognizes malformed provider responses", async () => {
    const provider = new ManagedProvider(
      new MockProvider({}, () => ({ usage: { inputTokens: 1, outputTokens: 1 } } as ProviderResponse)),
      {
        maxRetries: 0
      } as Pick<ProviderConfig, "maxRetries">
    );

    await expect(provider.generate(createProviderInput("malformed"))).rejects.toMatchObject({
      category: "malformed_response"
    });
  });

  it("passes configured token output budget to OpenAI-compatible providers", async () => {
    let requestBody: { max_tokens?: number } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { max_tokens?: number };
        return Promise.resolve(jsonResponse({
          choices: [
            {
              index: 0,
              message: {
                content: "ok",
                role: "assistant"
              }
            }
          ],
          usage: {
            completion_tokens: 1,
            prompt_tokens: 1,
            total_tokens: 2
          }
        }));
      })
    );
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini"
      }
    );
    const input = createProviderInput("budgeted");
    input.tokenBudget.outputLimit = 1_234;

    await provider.generate(input);

    expect(requestBody?.max_tokens).toBe(1_234);
  });

  it("passes configured token output budget to Anthropic-compatible providers", async () => {
    let requestBody: { max_tokens?: number } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { max_tokens?: number };
        return Promise.resolve(jsonResponse({
          content: [
            {
              text: "ok",
              type: "text"
            }
          ],
          model: "claude-sonnet-4-20250514",
          usage: {
            input_tokens: 1,
            output_tokens: 1
          }
        }));
      })
    );
    const provider = new AnthropicCompatibleProvider(
      {
        apiKey: "anthropic-test-key",
        baseUrl: "https://anthropic.example.test",
        maxRetries: 0,
        model: "claude-sonnet-4-20250514",
        name: "anthropic",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: "https://api.anthropic.com",
        defaultDisplayName: "Anthropic",
        defaultModel: "claude-sonnet-4-20250514"
      }
    );
    const input = createProviderInput("budgeted");
    input.tokenBudget.outputLimit = 2_345;

    await provider.generate(input);

    expect(requestBody?.max_tokens).toBe(2_345);
  });

  it("keeps streaming capability consistent between manifests and runtime providers", () => {
    const manifests = listProviderManifests();

    for (const manifest of manifests) {
      if (manifest.transport === "mock") {
        continue;
      }
      const defaults = resolveDefaultProviderSettings(manifest.name);
      const provider = createProvider({
        ...defaults,
        anthropicVersion: manifest.anthropicCompatible?.anthropicVersion ?? null,
        builtinProviderName: manifest.name,
        configPath: ".auto-talon/provider.config.json",
        configSource: "defaults",
        displayName: manifest.displayName,
        family: manifest.family,
        name: manifest.name,
        providerLabel:
          manifest.openAiCompatible?.providerLabel ?? manifest.anthropicCompatible?.providerLabel ?? null,
        transport: manifest.transport
      });

      expect(provider.capabilities?.streaming).toBe(manifest.supportsStreaming);
    }
  });
});

function runProviderContractSuite(name: string, harness: ProviderContractHarness): void {
  describe(name, () => {
    it("handles standard text generation", async () => {
      const response = await harness.createTextProvider().generate(createProviderInput("summarize"));
      expect(response.kind).toBe("final");
      expect(response.message.length).toBeGreaterThanOrEqual(0);
    });

    it("handles tool call responses", async () => {
      const response = await harness
        .createToolCallProvider()
        .generate(createProviderInput("read README.md"));

      expect(response.kind).toBe("tool_calls");
      if (response.kind !== "tool_calls") {
        throw new Error("Expected tool call response.");
      }

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls[0]?.toolName).toBe("file_read");
    });

    it("accepts empty responses", async () => {
      const response = await harness.createEmptyProvider().generate(createProviderInput("empty"));
      expect(response.kind).toBe("final");
      expect(response.message).toBe("");
    });

    it("rejects malformed response structures", async () => {
      await expect(
        harness.createMalformedResponseProvider().generate(createProviderInput("malformed"))
      ).rejects.toMatchObject({
        category: "malformed_response"
      });
    });

    it("maps transient network failures", async () => {
      await expect(
        harness.createNetworkFailureProvider(0).generate(createProviderInput("network"))
      ).rejects.toMatchObject({
        category: "transient_network_error"
      });
    });

    it("maps timeout failures", async () => {
      await expect(
        harness.createTimeoutProvider(0).generate(createProviderInput("timeout"))
      ).rejects.toMatchObject({
        category: "timeout_error"
      });
    });

    it("maps rate limit failures", async () => {
      await expect(
        harness.createRateLimitProvider(0).generate(createProviderInput("rate"))
      ).rejects.toMatchObject({
        category: "rate_limit"
      });
    });

    it("maps auth failures", async () => {
      await expect(
        harness.createAuthErrorProvider().generate(createProviderInput("auth"))
      ).rejects.toMatchObject({
        category: "auth_error"
      });
    });

    it("maps provider unavailable failures", async () => {
      await expect(
        harness.createUnavailableProvider(0).generate(createProviderInput("unavailable"))
      ).rejects.toMatchObject({
        category: "provider_unavailable"
      });
    });

    it("exposes provider descriptor for compatibility checks", () => {
      const provider = harness.createDescribableProvider();
      expect(typeof provider.describe).toBe("function");

      const descriptor = provider.describe?.();
      expect(descriptor).toBeDefined();
      expect(descriptor?.name).toBe(provider.name);
      expect(descriptor?.capabilities).toEqual(provider.capabilities);
      expect(descriptor?.baseUrl).not.toBeUndefined();
    });
  });
}

function createMockHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedMock(() => {
        throw providerError("auth_error", "bad key", false);
      }),
    createDescribableProvider: () => managedOpenAiCompatible(jsonResponse({
      choices: [
        {
          index: 0,
          message: {
            content: "ok",
            role: "assistant"
          }
        }
      ],
      usage: {
        completion_tokens: 1,
        prompt_tokens: 1,
        total_tokens: 2
      }
    })),
    createEmptyProvider: () => managedMock(() => finalResponse("")),
    createMalformedResponseProvider: () =>
      managedMock(() => ({ kind: "final", usage: { inputTokens: 1, outputTokens: 1 } } as ProviderResponse)),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw new Error("socket closed");
      }, maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw providerError("rate_limit", "slow down", true);
      }, maxRetries),
    createTextProvider: () => managedMockProvider(new MockProvider()),
    createTimeoutProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw new DOMException("timeout", "AbortError");
      }, maxRetries),
    createToolCallProvider: () => managedMockProvider(new MockProvider()),
    createUnavailableProvider: (maxRetries = 0) =>
      managedMock(() => {
        throw providerError("provider_unavailable", "service down", true);
      }, maxRetries)
  };
}

function createGlmHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedGlm(jsonResponse({
        error: {
          message: "invalid api key",
          type: "authentication_error"
        }
      }, 401)),
    createDescribableProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "descriptor",
              role: "assistant"
            }
          }
        ],
        model: "glm-4.5-air",
        usage: {
          completion_tokens: 1,
          prompt_tokens: 1,
          total_tokens: 2
        }
      })),
    createEmptyProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              content: "",
              role: "assistant"
            }
          }
        ],
        usage: {
          completion_tokens: 0,
          prompt_tokens: 1,
          total_tokens: 1
        }
      })),
    createMalformedResponseProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            message: {
              content: "Need a tool.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{bad json",
                    name: "file_read"
                  },
                  id: "call-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        usage: {
          completion_tokens: 0,
          prompt_tokens: 1,
          total_tokens: 1
        }
      })),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedGlm(() => Promise.reject(new Error("socket hang up")), maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedGlm(jsonResponse({
        error: {
          message: "too many requests",
          type: "rate_limit_error"
        }
      }, 429), maxRetries),
    createTextProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "glm text",
              role: "assistant"
            }
          }
        ],
        model: "glm-4.5-air",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5
        }
      })),
    createTimeoutProvider: (maxRetries = 0) =>
      managedGlm(() => Promise.reject(new DOMException("timeout", "AbortError")), maxRetries),
    createToolCallProvider: () =>
      managedGlm(jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            message: {
              content: "Need a tool.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{\"path\":\"README.md\",\"action\":\"read_file\"}",
                    name: "file_read"
                  },
                  id: "call-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        model: "glm-4.5-air",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5
        }
      })),
    createUnavailableProvider: (maxRetries = 0) =>
      managedGlm(jsonResponse({
        error: {
          message: "service unavailable",
          type: "service_unavailable"
        }
      }, 503), maxRetries)
  };
}

function createOpenAiCompatibleHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedOpenAiCompatible(jsonResponse({
        error: {
          message: "invalid api key",
          type: "authentication_error"
        }
      }, 401)),
    createDescribableProvider: () =>
      managedOpenAiCompatible(jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "descriptor",
              role: "assistant"
            }
          }
        ],
        model: "kimi-k2",
        usage: {
          completion_tokens: 1,
          prompt_tokens: 1,
          total_tokens: 2
        }
      })),
    createEmptyProvider: () =>
      managedOpenAiCompatible(jsonResponse({
        choices: [
          {
            index: 0,
            message: {
              content: "",
              role: "assistant"
            }
          }
        ],
        usage: {
          completion_tokens: 0,
          prompt_tokens: 1,
          total_tokens: 1
        }
      })),
    createMalformedResponseProvider: () =>
      managedOpenAiCompatible(jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            message: {
              content: "Need a tool.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{bad json",
                    name: "file_read"
                  },
                  id: "call-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        usage: {
          completion_tokens: 0,
          prompt_tokens: 1,
          total_tokens: 1
        }
      })),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedOpenAiCompatible(() => Promise.reject(new Error("socket hang up")), maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedOpenAiCompatible(jsonResponse({
        error: {
          message: "too many requests",
          type: "rate_limit_error"
        }
      }, 429), maxRetries),
    createTextProvider: () =>
      managedOpenAiCompatible(jsonResponse({
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: "compatible text",
              role: "assistant"
            }
          }
        ],
        model: "kimi-k2",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5
        }
      })),
    createTimeoutProvider: (maxRetries = 0) =>
      managedOpenAiCompatible(() => Promise.reject(new DOMException("timeout", "AbortError")), maxRetries),
    createToolCallProvider: () =>
      managedOpenAiCompatible(jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            index: 0,
            message: {
              content: "Need a tool.",
              role: "assistant",
              tool_calls: [
                {
                  function: {
                    arguments: "{\"path\":\"README.md\",\"action\":\"read_file\"}",
                    name: "file_read"
                  },
                  id: "call-1",
                  type: "function"
                }
              ]
            }
          }
        ],
        model: "kimi-k2",
        usage: {
          completion_tokens: 2,
          prompt_tokens: 3,
          total_tokens: 5
        }
      })),
    createUnavailableProvider: (maxRetries = 0) =>
      managedOpenAiCompatible(jsonResponse({
        error: {
          message: "service unavailable",
          type: "service_unavailable"
        }
      }, 503), maxRetries)
  };
}

function createAnthropicHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        error: {
          message: "invalid api key",
          type: "authentication_error"
        },
        type: "error"
      }, 401), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }),
    createDescribableProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            text: "descriptor",
            type: "text"
          }
        ],
        id: "msg-descriptor",
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }),
    createEmptyProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [],
        id: "msg-empty",
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 0
        }
      }), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }),
    createMalformedResponseProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            id: "call-1",
            input: "bad-input",
            name: "file_read",
            type: "tool_use"
          }
        ],
        id: "msg-malformed",
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(() => Promise.reject(new Error("socket hang up")), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }, maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(jsonResponse({
        error: {
          message: "too many requests",
          type: "rate_limit_error"
        },
        type: "error"
      }, 429), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }, maxRetries),
    createTextProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            text: "anthropic text",
            type: "text"
          }
        ],
        id: "msg-text",
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 3,
          output_tokens: 2
        }
      }), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }),
    createTimeoutProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(() => Promise.reject(new DOMException("timeout", "AbortError")), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }, maxRetries),
    createToolCallProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            text: "Need a tool.",
            type: "text"
          },
          {
            id: "call-1",
            input: {
              action: "read_file",
              path: "README.md"
            },
            name: "file_read",
            type: "tool_use"
          }
        ],
        id: "msg-tool",
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
        type: "message",
        usage: {
          input_tokens: 3,
          output_tokens: 2
        }
      }), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }),
    createUnavailableProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(jsonResponse({
        error: {
          message: "service unavailable",
          type: "service_unavailable"
        },
        type: "error"
      }, 503), {
        model: "claude-sonnet-4-20250514",
        name: "anthropic"
      }, maxRetries)
  };
}

function createMiniMaxHarness(): ProviderContractHarness {
  return {
    createAuthErrorProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        error: {
          message: "invalid api key",
          type: "authentication_error"
        },
        type: "error"
      }, 401), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }),
    createDescribableProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            text: "descriptor",
            type: "text"
          }
        ],
        id: "msg-descriptor",
        model: "MiniMax-M2.7",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }),
    createEmptyProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [],
        id: "msg-empty",
        model: "MiniMax-M2.7",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 0
        }
      }), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }),
    createMalformedResponseProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            id: "call-1",
            input: "bad-input",
            name: "file_read",
            type: "tool_use"
          }
        ],
        id: "msg-malformed",
        model: "MiniMax-M2.7",
        stop_reason: "tool_use",
        type: "message",
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }),
    createNetworkFailureProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(() => Promise.reject(new Error("socket hang up")), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }, maxRetries),
    createRateLimitProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(jsonResponse({
        error: {
          message: "too many requests",
          type: "rate_limit_error"
        },
        type: "error"
      }, 429), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }, maxRetries),
    createTextProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            text: "minimax text",
            type: "text"
          }
        ],
        id: "msg-text",
        model: "MiniMax-M2.7",
        stop_reason: "end_turn",
        type: "message",
        usage: {
          input_tokens: 3,
          output_tokens: 2
        }
      }), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }),
    createTimeoutProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(() => Promise.reject(new DOMException("timeout", "AbortError")), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }, maxRetries),
    createToolCallProvider: () =>
      managedAnthropicCompatible(jsonResponse({
        content: [
          {
            text: "Need a tool.",
            type: "text"
          },
          {
            id: "call-1",
            input: {
              action: "read_file",
              path: "README.md"
            },
            name: "file_read",
            type: "tool_use"
          }
        ],
        id: "msg-tool",
        model: "MiniMax-M2.7",
        stop_reason: "tool_use",
        type: "message",
        usage: {
          input_tokens: 3,
          output_tokens: 2
        }
      }), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }),
    createUnavailableProvider: (maxRetries = 0) =>
      managedAnthropicCompatible(jsonResponse({
        error: {
          message: "service unavailable",
          type: "service_unavailable"
        },
        type: "error"
      }, 503), {
        baseUrl: "https://api.minimax.io/anthropic",
        model: "MiniMax-M2.7",
        name: "minimax"
      }, maxRetries)
  };
}

function managedMock(
  responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse,
  maxRetries = 0
): Provider {
  return managedMockProvider(new MockProvider({}, responder), maxRetries);
}

function managedMockProvider(provider: Provider, maxRetries = 0): Provider {
  return new ManagedProvider(provider, { maxRetries } as Pick<ProviderConfig, "maxRetries">);
}

function managedGlm(
  fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | Response,
  maxRetries = 0
): Provider {
  const implementation =
    fetchImpl instanceof Response ? vi.fn(() => Promise.resolve(fetchImpl.clone())) : vi.fn(fetchImpl);
  vi.stubGlobal("fetch", implementation);

  return new ManagedProvider(
    new GlmProvider({
      apiKey: "glm-test-key",
      baseUrl: "https://glm.example.test/v4",
      maxRetries: 0,
      model: "glm-4.5-air",
      name: "glm",
      timeoutMs: 5_000
    }),
    { maxRetries } as Pick<ProviderConfig, "maxRetries">
  );
}

function managedOpenAiCompatible(
  fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | Response,
  maxRetries = 0
): Provider {
  const implementation =
    fetchImpl instanceof Response ? vi.fn(() => Promise.resolve(fetchImpl.clone())) : vi.fn(fetchImpl);
  vi.stubGlobal("fetch", implementation);

  return new ManagedProvider(
    new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini"
      }
    ),
    { maxRetries } as Pick<ProviderConfig, "maxRetries">
  );
}

function managedAnthropicCompatible(
  fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | Response,
  overrides: Partial<ProviderConfig>,
  maxRetries = 0
): Provider {
  const implementation =
    fetchImpl instanceof Response ? vi.fn(() => Promise.resolve(fetchImpl.clone())) : vi.fn(fetchImpl);
  vi.stubGlobal("fetch", implementation);

  return new ManagedProvider(
    new AnthropicCompatibleProvider(
      {
        apiKey: "anthropic-test-key",
        baseUrl: "https://anthropic.example.test",
        maxRetries: 0,
        model: "claude-sonnet-4-20250514",
        name: "anthropic",
        timeoutMs: 5_000,
        ...overrides
      },
      {
        anthropicVersion: "2023-06-01",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultDisplayName: "Anthropic",
        defaultModel: "claude-sonnet-4-20250514"
      }
    ),
    { maxRetries } as Pick<ProviderConfig, "maxRetries">
  );
}

function providerError(
  category: ProviderError["category"],
  message: string,
  retriable: boolean
): ProviderError {
  return new ProviderError({
    category,
    message,
    providerName: "mock",
    retriable,
    summary: message
  });
}
