import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApplication, createApplicationAsync, createDefaultRunOptions } from "../src/runtime/index.js";
import {
  AnthropicCompatibleProvider,
  createProvider,
  GlmProvider,
  OpenAiCompatibleProvider,
  ProviderError,
  resolveProviderCatalog,
  resolveProviderConfig
} from "../src/providers/index.js";
import type {
  Provider,
  ProviderConfig,
  ProviderHealthCheck,
  ProviderInput,
  ProviderResponse
} from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse,
    public readonly model = "scripted-model"
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }

  public testConnection(): Promise<ProviderHealthCheck> {
    return Promise.resolve({
      apiKeyConfigured: true,
      endpointReachable: true,
      message: "scripted provider reachable",
      modelAvailable: true,
      modelConfigured: true,
      modelName: this.model,
      ok: true,
      providerName: this.name
    });
  }
}

const tempPaths: string[] = [];

beforeEach(() => {
  delete process.env.AGENT_PROVIDER;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_PROVIDER_API_KEY;
  delete process.env.AGENT_PROVIDER_BASE_URL;
  delete process.env.AGENT_PROVIDER_MODEL;
  delete process.env.AGENT_PROVIDER_TIMEOUT_MS;
  delete process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS;
  delete process.env.AGENT_PROVIDER_MAX_RETRIES;
  delete process.env.AGENT_USER_CONFIG_DIR;

  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("Provider integration", () => {
  it("starts in an explicit unconfigured state when no provider default exists", async () => {
    const workspaceRoot = await createTempWorkspace();
    const userConfigDir = await createTempWorkspace();
    delete process.env.AGENT_PROVIDER;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      expect(handle.service.currentProvider()).toMatchObject({
        configured: false,
        name: "unconfigured"
      });

      const health = await handle.service.testCurrentProvider();
      expect(health.ok).toBe(false);
      expect(health.message).toContain("No provider is configured");

      const result = await handle.service.runTask(
        createDefaultRunOptions("summarize README.md", workspaceRoot, handle.config)
      );
      expect(result.task.status).toBe("failed");
      expect(result.error?.message).toContain("No provider is configured");
    } finally {
      handle.close();
    }
  });

  it("loads user provider defaults before workspace provider overrides", async () => {
    const workspaceRoot = await createTempWorkspace();
    const userConfigDir = await createTempWorkspace();
    delete process.env.AGENT_PROVIDER;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(userConfigDir, "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "glm",
          providers: {
            glm: {
              apiKey: "user-glm-key",
              timeoutMs: 11_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          providers: {
            glm: {
              timeoutMs: 17_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("glm");
    expect(resolved.apiKey).toBe("user-glm-key");
    expect(resolved.timeoutMs).toBe(17_000);
    expect(resolved.configSource).toBe("file");
    expect(resolved.configPath).toBe(join(workspaceRoot, ".auto-talon", "provider.config.json"));
  });

  it("uses resilient remote timeout defaults while preserving explicit short timeout diagnostics", async () => {
    const workspaceRoot = await createTempWorkspace();
    process.env.AGENT_PROVIDER = "openai";

    const defaults = resolveProviderConfig(workspaceRoot);

    expect(defaults.timeoutMs).toBe(120_000);
    expect(defaults.streamIdleTimeoutMs).toBe(300_000);
    expect(defaults.timeoutConfigured).toBe(false);

    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "openai",
        providers: { openai: { timeoutMs: 30_000 } }
      }),
      "utf8"
    );
    delete process.env.AGENT_PROVIDER;

    const explicit = resolveProviderConfig(workspaceRoot);

    expect(explicit.timeoutMs).toBe(30_000);
    expect(explicit.timeoutConfigured).toBe(true);
    expect(explicit.streamIdleTimeoutMs).toBe(300_000);
  });

  it("keeps MockProvider configurable and runnable", async () => {
    const workspaceRoot = await createTempWorkspace();
    process.env.AGENT_PROVIDER = "mock";
    await fs.writeFile(join(workspaceRoot, "README.md"), "provider test", "utf8");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read README.md", workspaceRoot, handle.config)
      );

      expect(handle.service.currentProvider().name).toBe("mock");
      expect(result.task.status).toBe("succeeded");
      expect(result.output).toContain("Task completed from tool feedback.");
    } finally {
      handle.close();
    }
  });

  it("uses the routed provider instead of silently reusing the current provider", async () => {
    const workspaceRoot = await createTempWorkspace();
    process.env.AGENT_PROVIDER = "mock";
    await fs.writeFile(join(workspaceRoot, "README.md"), "provider test", "utf8");
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        routing: {
          helpers: { classify: null, recallRank: null, summarize: "cheap" },
          mode: "quality_first",
          providers: { balanced: "mock", cheap: "mock", quality: "openai" }
        }
      }
    });

    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("read README.md", workspaceRoot, handle.config)
      );

      expect(handle.service.currentProvider().name).toBe("mock");
      expect(result.task.status).toBe("failed");
      expect(result.error?.message).toContain("OpenAI API key is not configured");
      expect(
        handle.service
          .traceTask(result.task.taskId)
          .some((event) => event.eventType === "provider_request_failed" && event.payload.providerName === "openai")
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("loads GLM provider configuration from file", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "glm",
          providers: {
            glm: {
              apiKey: "glm-test-key",
              baseUrl: "https://glm.example.test/v4",
              maxRetries: 4,
              model: "glm-4.5-air",
              timeoutMs: 12_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("glm");
    expect(resolved.apiKey).toBe("glm-test-key");
    expect(resolved.baseUrl).toBe("https://glm.example.test/v4");
    expect(resolved.model).toBe("glm-4.5-air");
    expect(resolved.timeoutMs).toBe(12_000);
    expect(resolved.maxRetries).toBe(4);
    expect(resolved.configSource).toBe("file");
    expect(resolved.contextWindowTokens).toBe(128_000);
    expect(resolved.contextWindowSource).toBe("provider_model_manifest");
  });

  it("resolves model-specific context window for OpenAI o1", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "openai",
          providers: {
            openai: {
              apiKey: "openai-test-key",
              model: "o1"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("openai");
    expect(resolved.model).toBe("o1");
    expect(resolved.contextWindowTokens).toBe(200_000);
    expect(resolved.contextWindowSource).toBe("provider_model_manifest");
  });

  it("loads OpenAI-compatible provider configuration from file aliases", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "openai-compatible",
          providers: {
            "openai-compatible": {
              apiKey: "compat-test-key",
              baseUrl: "https://compat.example.test/v1",
              contextWindowTokens: 200_000,
              maxRetries: 3,
              model: "kimi-k2",
              timeoutMs: 15_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("openai-compatible");
    expect(resolved.apiKey).toBe("compat-test-key");
    expect(resolved.baseUrl).toBe("https://compat.example.test/v1");
    expect(resolved.model).toBe("kimi-k2");
    expect(resolved.timeoutMs).toBe(15_000);
    expect(resolved.maxRetries).toBe(3);
    expect(resolved.contextWindowTokens).toBe(200_000);
    expect(resolved.contextWindowSource).toBe("provider_config");
  });

  it("loads iFLYTEK Coding Plan provider configuration from file", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "xfyun-coding",
          providers: {
            "xfyun-coding": {
              apiKey: "xfyun-test-key",
              maxRetries: 5,
              timeoutMs: 18_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("xfyun-coding");
    expect(resolved.apiKey).toBe("xfyun-test-key");
    expect(resolved.baseUrl).toBe("https://maas-coding-api.cn-huabei-1.xf-yun.com/v2");
    expect(resolved.model).toBe("astron-code-latest");
    expect(resolved.displayName).toBe("iFLYTEK Coding Plan");
    expect(resolved.family).toBe("openai-compatible");
    expect(resolved.transport).toBe("openai-compatible");
    expect(resolved.timeoutMs).toBe(18_000);
    expect(resolved.maxRetries).toBe(5);
    expect(resolved.contextWindowTokens).toBe(64_000);
    expect(resolved.contextWindowSource).toBe("provider_model_manifest");
    expect(createProvider(resolved).capabilities?.streaming).toBe(true);
  });

  it("uses fallback context window when provider context window is unavailable", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "openai-compatible",
        providers: {
          "openai-compatible": {
            apiKey: "compat-test-key",
            baseUrl: "https://compat.example.test/v1",
            model: "custom-model-without-manifest"
          }
        }
      }),
      "utf8"
    );
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });
    try {
      expect(handle.config.tokenBudget.inputLimit).toBe(32_000);
      expect(handle.config.provider.contextWindowTokens).toBe(32_000);
    } finally {
      handle.close();
    }
  });

  it("lets explicit tokenBudget.inputLimit override missing provider context window", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "xfyun-coding",
        providers: {
          "xfyun-coding": {
            apiKey: "xfyun-test-key"
          }
        }
      }),
      "utf8"
    );
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        tokenBudget: {
          inputLimit: 96_000
        }
      }),
      "utf8"
    );
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });
    try {
      expect(handle.config.tokenBudget.inputLimit).toBe(96_000);
      expect(handle.config.provider.contextWindowTokens).toBe(96_000);
      expect(handle.config.provider.contextWindowSource).toBe("explicit_token_budget");
    } finally {
      handle.close();
    }
  });

  it("lets createApplication config tokenBudget.inputLimit override missing provider context window", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "xfyun-coding",
        providers: {
          "xfyun-coding": {
            apiKey: "xfyun-test-key"
          }
        }
      }),
      "utf8"
    );
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        tokenBudget: {
          inputLimit: 88_000,
          outputLimit: 4_000,
          reservedOutput: 500,
          usedInput: 0,
          usedOutput: 0
        }
      }
    });
    try {
      expect(handle.config.tokenBudget.inputLimit).toBe(88_000);
      expect(handle.config.provider.contextWindowSource).toBe("explicit_token_budget");
    } finally {
      handle.close();
    }
  });

  it("loads custom OpenAI-compatible providers from config without code changes", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "vendor-coding",
          customProviders: {
            "vendor-coding": {
              apiKey: "vendor-test-key",
              baseUrl: "https://vendor.example.test/v1",
              displayName: "Vendor Coding",
              model: "vendor-code-latest",
              providerLabel: "Vendor Coding",
              timeoutMs: 16_000,
              transport: "openai-compatible"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("vendor-coding");
    expect(resolved.builtinProviderName).toBeNull();
    expect(resolved.apiKey).toBe("vendor-test-key");
    expect(resolved.baseUrl).toBe("https://vendor.example.test/v1");
    expect(resolved.model).toBe("vendor-code-latest");
    expect(resolved.displayName).toBe("Vendor Coding");
    expect(resolved.transport).toBe("openai-compatible");
    expect(resolved.timeoutMs).toBe(16_000);
  });

  it("loads Anthropic provider configuration from provider/model selectors", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "claude/claude-sonnet-4-20250514",
          providers: {
            claude: {
              apiKey: "anthropic-test-key",
              timeoutMs: 14_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("anthropic");
    expect(resolved.apiKey).toBe("anthropic-test-key");
    expect(resolved.baseUrl).toBe("https://api.anthropic.com");
    expect(resolved.model).toBe("claude-sonnet-4-20250514");
    expect(resolved.displayName).toBe("Anthropic");
    expect(resolved.family).toBe("anthropic-compatible");
    expect(resolved.transport).toBe("anthropic-compatible");
    expect(resolved.timeoutMs).toBe(14_000);
  });

  it("resolves provider aliases and provider/model references from config", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          currentProvider: "z.ai/glm-4.5-air",
          providers: {
            "zhipu": {
              apiKey: "glm-test-key",
              timeoutMs: 9_000
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const resolved = resolveProviderConfig(workspaceRoot);

    expect(resolved.name).toBe("glm");
    expect(resolved.model).toBe("glm-4.5-air");
    expect(resolved.apiKey).toBe("glm-test-key");
    expect(resolved.displayName).toBe("GLM");
    expect(resolved.family).toBe("openai-compatible");
    expect(resolved.transport).toBe("openai-compatible");
    expect(resolved.timeoutMs).toBe(9_000);
  });

  it("includes the first-batch and second-batch providers in the catalog", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      const providerNames = handle.service.listProviders().map((provider) => provider.name);
      expect(providerNames).toEqual(
        expect.arrayContaining([
          "openai",
          "anthropic",
          "xfyun-coding",
          "gemini",
          "openrouter",
          "ollama",
          "glm",
          "moonshot",
          "minimax",
          "qwen",
          "xai"
        ])
      );
    } finally {
      handle.close();
    }
  });

  it("includes configured custom providers in the catalog", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(
        {
          customProviders: {
            "vendor-coding": {
              baseUrl: "https://vendor.example.test/v1",
              displayName: "Vendor Coding",
              model: "vendor-code-latest",
              transport: "openai-compatible"
            }
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const catalog = resolveProviderCatalog(workspaceRoot);

    expect(catalog.some((provider) => provider.name === "vendor-coding")).toBe(true);
  });

  it("maps GLM tool calls into the unified provider response shape", async () => {
    const provider = new GlmProvider(createGlmConfig({
      apiKey: "glm-test-key",
      baseUrl: "https://glm.example.test/v4"
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                index: 0,
                message: {
                  content: "Need file access.",
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: "{\"path\":\"README.md\"}",
                        name: "read_file"
                      },
                      id: "call-1",
                      type: "function"
                    }
                  ]
                }
              }
            ],
            id: "resp-1",
            model: "glm-4.5-air",
            usage: {
              completion_tokens: 11,
              prompt_tokens: 22,
              total_tokens: 33
            }
          }),
          {
            status: 200
          }
        )
      )
    );

    const response = await provider.generate(createProviderInput());

    expect(response.kind).toBe("tool_calls");
    if (response.kind !== "tool_calls") {
      throw new Error("Expected tool call response.");
    }

    expect(response.toolCalls[0]).toEqual({
      input: {
        path: "README.md"
      },
      raw: {
        arguments: "{\"path\":\"README.md\"}",
        index: 0
      },
      reason: "Provider read_file tool call requested.",
      toolCallId: "call-1",
      toolName: "read_file"
    });
    expect(response.metadata?.providerName).toBe("glm");
    expect(response.metadata?.modelName).toBe("glm-4.5-air");
    expect(response.usage.totalTokens).toBe(33);
  });

  it("maps OpenAI-compatible responses into the unified provider response shape", async () => {
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

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
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
            id: "resp-compat-1",
            model: "kimi-k2",
            usage: {
              completion_tokens: 9,
              prompt_tokens: 12,
              total_tokens: 21
            }
          }),
          {
            status: 200
          }
        )
      )
    );

    const response = await provider.generate(createProviderInput());

    expect(response.kind).toBe("final");
    expect(response.message).toBe("compatible text");
    expect(response.metadata?.providerName).toBe("openai-compatible");
    expect(response.metadata?.modelName).toBe("kimi-k2");
  });

  it("preserves and replays reasoning_content for thinking-mode tool calls", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "deepseek-v4-pro",
        name: "deepseek",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "DeepSeek",
        defaultModel: "deepseek-v4-pro"
      }
    );

    let capturedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected JSON request body");
        }
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        const messages = capturedBody.messages as Array<Record<string, unknown>>;
        const hasToolResult = messages.some((message) => message.role === "tool");
        if (!hasToolResult) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                choices: [
                  {
                    finish_reason: "tool_calls",
                    index: 0,
                    message: {
                      content: "Let me read the file.",
                      reasoning_content: "Need to inspect README first.",
                      role: "assistant",
                      tool_calls: [
                        {
                          function: {
                            arguments: "{\"path\":\"README.md\"}",
                            name: "read_file"
                          },
                          id: "call-1",
                          type: "function"
                        }
                      ]
                    }
                  }
                ],
                id: "resp-thinking-1",
                model: "deepseek-v4-pro",
                usage: {
                  completion_tokens: 9,
                  prompt_tokens: 12,
                  total_tokens: 21
                }
              }),
              { status: 200 }
            )
          );
        }

        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  message: {
                    content: "Done.",
                    role: "assistant"
                  }
                }
              ],
              id: "resp-thinking-2",
              model: "deepseek-v4-pro",
              usage: {
                completion_tokens: 4,
                prompt_tokens: 20,
                total_tokens: 24
              }
            }),
            { status: 200 }
          )
        );
      })
    );

    const firstResponse = await provider.generate({
      ...createProviderInput(),
      availableTools: [
        {
          capability: "filesystem_read",
          description: "Read a file",
          inputSchema: {
            properties: {
              path: { type: "string" }
            },
            required: ["path"],
            type: "object"
          },
          name: "read_file",
          privacyLevel: "workspace",
          riskLevel: "low"
        }
      ]
    });

    expect(firstResponse.kind).toBe("tool_calls");
    if (firstResponse.kind !== "tool_calls") {
      throw new Error("expected tool_calls");
    }
    expect(firstResponse.reasoningContent).toBe("Need to inspect README first.");

    const followUp = await provider.generate({
      ...createProviderInput(),
      availableTools: [
        {
          capability: "filesystem_read",
          description: "Read a file",
          inputSchema: {
            properties: {
              path: { type: "string" }
            },
            required: ["path"],
            type: "object"
          },
          name: "read_file",
          privacyLevel: "workspace",
          riskLevel: "low"
        }
      ],
      messages: [
        { content: "read README.md", role: "user" },
        {
          content: firstResponse.message,
          reasoningContent: firstResponse.reasoningContent,
          role: "assistant",
          toolCalls: firstResponse.toolCalls
        },
        {
          content: "README contents",
          role: "tool",
          toolCallId: "call-1",
          toolName: "read_file"
        }
      ]
    });

    expect(followUp.kind).toBe("final");
    const replayedMessages = (capturedBody?.messages ?? []) as Array<Record<string, unknown>>;
    const assistantMessage = replayedMessages.find(
      (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
    );
    expect(assistantMessage?.reasoning_content).toBe("Need to inspect README first.");
  });

  it("uses non-streaming requests when OpenAI-compatible streaming is disabled", async () => {
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
        defaultModel: "gpt-4o-mini",
        supportsStreaming: false
      }
    );
    let streamed = "";

    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        expect(typeof init?.body).toBe("string");
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        expect(body.stream).toBe(false);
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: {
                  content: "non-streamed text",
                  role: "assistant"
                }
              }
            ],
            id: "resp-non-streamed",
            model: "kimi-k2",
            usage: {
              completion_tokens: 3,
              prompt_tokens: 7,
              total_tokens: 10
            }
          }),
          {
            status: 200
          }
        );
      })
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: (delta) => {
        streamed += delta;
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("non-streamed text");
    expect(streamed).toBe("");
  });

  it("parses a final OpenAI-compatible stream event without a trailing newline", async () => {
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
    let streamed = "";

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          [
            'data: {"choices":[{"index":0,"delta":{"content":"hel"}}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
            'data: {"choices":[{"index":0,"delta":{"content":"lo"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
            "data: [DONE]"
          ].join(""),
          {
            headers: {
              "Content-Type": "text/event-stream"
            },
            status: 200
          }
        )
      )
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: (delta) => {
        streamed += delta;
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("hello");
    expect(response.usage.totalTokens).toBe(5);
    expect(streamed).toBe("hello");
  });

  it("falls back to complete-only when OpenAI-compatible streaming fails before progress", async () => {
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
    const statuses: string[] = [];
    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          return new Response(JSON.stringify({ error: { message: "stream unsupported", type: "unsupported" } }), {
            status: 501
          });
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: { content: "fallback answer", role: "assistant" }
              }
            ],
            id: "resp-fallback",
            model: "kimi-k2",
            usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
          }),
          { status: 200 }
        );
      })
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onProviderStatus: (notice) => statuses.push(notice.kind),
      onTextDelta: () => {
        throw new Error("fallback should not stream text");
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("fallback answer");
    expect(requestModes).toEqual([true, false]);
    expect(statuses).toEqual(["streaming_fallback"]);
  });

  it("falls back to complete-only after OpenAI-compatible streaming is interrupted", async () => {
    const encoder = new TextEncoder();
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
    let streamed = "";
    let pulled = false;
    const requestModes: Array<boolean | undefined> = [];
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { stream?: boolean };
      requestModes.push(body.stream);
      if (body.stream === true) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!pulled) {
                  pulled = true;
                  controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
                  return;
                }
                controller.error(new Error("stream broke"));
              }
            }),
            { status: 200 }
          )
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: { content: "complete answer", role: "assistant" }
              }
            ],
            id: "resp-after-interrupt",
            model: "kimi-k2",
            usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
          }),
          { status: 200 }
        )
      );
    }
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: (delta) => {
        streamed += delta;
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("complete answer");
    expect(streamed).toBe("partial");
    expect(requestModes).toEqual([true, false]);
  });

  it("falls back when OpenAI-compatible tool-call streaming fails before visible text", async () => {
    const encoder = new TextEncoder();
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
    let pulled = false;
    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  if (!pulled) {
                    pulled = true;
                    controller.enqueue(
                      encoder.encode(
                        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_file","arguments":"{\\""}}]}}]}\n\n'
                      )
                    );
                    return;
                  }
                  controller.error(new Error("Streaming provider read failed."));
                }
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  index: 0,
                  message: {
                    content: "",
                    role: "assistant",
                    tool_calls: [
                      {
                        function: {
                          arguments: JSON.stringify({ path: "README.md" }),
                          name: "read_file"
                        },
                        id: "call-fallback",
                        type: "function"
                      }
                    ]
                  }
                }
              ],
              id: "tool-fallback",
              model: "kimi-k2",
              usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 }
            }),
            { status: 200 }
          )
        );
      })
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: () => {
        throw new Error("tool-call fallback should not emit visible text");
      }
    });

    expect(response.kind).toBe("tool_calls");
    if (response.kind !== "tool_calls") {
      throw new Error("Expected fallback response to contain tool calls.");
    }
    expect(response.toolCalls[0]?.toolCallId).toBe("call-fallback");
    expect(requestModes).toEqual([true, false]);
  });

  it("resets OpenAI-compatible stream idle timeout after chunks", async () => {
    const encoder = new TextEncoder();
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        streamIdleTimeoutMs: 50,
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini"
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                await wait(10);
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n')
                );
                await wait(10);
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
            }),
            { status: 200 }
          )
        )
      )
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: () => {}
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("hi");
  });

  it("falls back when an OpenAI-compatible stream goes idle before progress", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "kimi-k2",
        name: "openai-compatible",
        streamIdleTimeoutMs: 5,
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "OpenAI Compatible",
        defaultModel: "gpt-4o-mini"
      }
    );
    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          return Promise.resolve(
            new Response(new ReadableStream<Uint8Array>({ pull() {} }), { status: 200 })
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  message: { content: "idle fallback", role: "assistant" }
                }
              ],
              id: "idle-fallback",
              model: "kimi-k2",
              usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 }
            }),
            { status: 200 }
          )
        );
      })
    );

    const response = await provider.generate({
      ...createProviderInput(),
      onTextDelta: () => {}
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("idle fallback");
    expect(requestModes).toEqual([true, false]);
  });

  it("retries streaming on the next request after a transient OpenAI-compatible streaming failure", async () => {
    const encoder = new TextEncoder();
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

    const requestModes: Array<boolean | undefined> = [];
    let streamCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          streamCallCount += 1;
          if (streamCallCount === 1) {
            return Promise.reject(new TypeError("fetch failed"));
          }
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"streamed-2"}}]}\n\n')
                  );
                  controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                  controller.close();
                }
              }),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  message: { content: "fallback-1", role: "assistant" }
                }
              ],
              id: "transient-fallback",
              model: "kimi-k2",
              usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
            }),
            { status: 200 }
          )
        );
      })
    );

    const statuses: string[] = [];
    let firstStreamed = "";
    const firstResponse = await provider.generate({
      ...createProviderInput(),
      onProviderStatus: (notice) => statuses.push(notice.kind),
      onTextDelta: (delta) => {
        firstStreamed += delta;
      }
    });
    expect(firstResponse.kind).toBe("final");
    expect(firstResponse.message).toBe("fallback-1");
    expect(firstStreamed).toBe("");

    let secondStreamed = "";
    const secondResponse = await provider.generate({
      ...createProviderInput(),
      onProviderStatus: (notice) => statuses.push(notice.kind),
      onTextDelta: (delta) => {
        secondStreamed += delta;
      }
    });
    expect(secondResponse.kind).toBe("final");
    expect(secondResponse.message).toBe("streamed-2");
    expect(secondStreamed).toBe("streamed-2");
    // Transient failures must not emit the persistent streaming_fallback notice.
    expect(statuses).toEqual([]);
    expect(requestModes).toEqual([true, false, true]);
  });

  it("persistently disables OpenAI-compatible streaming after consecutive transient failures", async () => {
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

    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          return Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  message: { content: "complete-only", role: "assistant" }
                }
              ],
              id: "transient-loop",
              model: "kimi-k2",
              usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
            }),
            { status: 200 }
          )
        );
      })
    );

    const statuses: string[] = [];
    const reasons: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await provider.generate({
        ...createProviderInput(),
        onProviderStatus: (notice) => {
          statuses.push(notice.kind);
          reasons.push(notice.reason);
        },
        onTextDelta: () => {
          throw new Error("transient loop should not stream text");
        }
      });
      expect(response.kind).toBe("final");
      expect(response.message).toBe("complete-only");
    }

    // Three transient streaming attempts, then one fallback that doesn't even try streaming.
    expect(requestModes).toEqual([true, false, true, false, true, false, false]);
    expect(statuses).toEqual(["streaming_fallback"]);
    expect(reasons[0] ?? "").toContain("consecutive transient streaming failures");
  });

  it("immediately disables OpenAI-compatible streaming when the endpoint signals it is unsupported", async () => {
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
    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: "stream unsupported", type: "unsupported" } }), {
              status: 501
            })
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  message: { content: "complete-only", role: "assistant" }
                }
              ],
              id: "persistent-disable",
              model: "kimi-k2",
              usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
            }),
            { status: 200 }
          )
        );
      })
    );

    const statuses: string[] = [];
    const first = await provider.generate({
      ...createProviderInput(),
      onProviderStatus: (notice) => statuses.push(notice.kind),
      onTextDelta: () => {
        throw new Error("persistent disable should not stream text");
      }
    });
    expect(first.kind).toBe("final");
    expect(first.message).toBe("complete-only");

    const second = await provider.generate({
      ...createProviderInput(),
      onProviderStatus: (notice) => statuses.push(notice.kind),
      onTextDelta: () => {
        throw new Error("streaming should be disabled after the first persistent failure");
      }
    });
    expect(second.kind).toBe("final");
    expect(second.message).toBe("complete-only");

    // Persistent disable: streaming attempted exactly once, then never again.
    expect(requestModes).toEqual([true, false, false]);
    expect(statuses).toEqual(["streaming_fallback"]);
  });

  it("falls back to complete-only when an OpenAI-compatible streaming response is HTTP-classified as unknown_error", async () => {
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

    const requestModes: Array<boolean | undefined> = [];
    let streamCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          streamCallCount += 1;
          if (streamCallCount === 1) {
            // 422 maps to `unknown_error` via classifyProviderHttpError; the streaming
            // attempt should still fall back to a non-streaming retry instead of
            // surfacing the error to the caller.
            return Promise.resolve(
              new Response(JSON.stringify({ error: { message: "tool schema rejected" } }), { status: 422 })
            );
          }
          return Promise.reject(new Error("second streaming attempt should not happen"));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "stop",
                  index: 0,
                  message: { content: "fallback-after-422", role: "assistant" }
                }
              ],
              id: "fallback-422",
              model: "kimi-k2",
              usage: { completion_tokens: 2, prompt_tokens: 4, total_tokens: 6 }
            }),
            { status: 200 }
          )
        );
      })
    );

    const statuses: string[] = [];
    const response = await provider.generate({
      ...createProviderInput(),
      onProviderStatus: (notice) => statuses.push(notice.kind),
      onTextDelta: () => {
        throw new Error("422 fallback should not stream text");
      }
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("fallback-after-422");
    expect(requestModes).toEqual([true, false]);
    // First transient failure must not emit the persistent streaming_fallback notice.
    expect(statuses).toEqual([]);
  });

  it("propagates OpenAI-compatible auth errors instead of looping into a non-streaming retry", async () => {
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

    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: "invalid api key", type: "auth" } }), { status: 401 })
        );
      })
    );

    await expect(
      provider.generate({
        ...createProviderInput(),
        onTextDelta: () => {
          throw new Error("auth failure should not stream text");
        }
      })
    ).rejects.toMatchObject({ category: "auth_error" });

    expect(requestModes).toEqual([true]);
  });

  it("propagates OpenAI-compatible invalid_request errors instead of looping into a non-streaming retry", async () => {
    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: "https://compat.example.test/v1",
        maxRetries: 0,
        model: "deepseek-chat",
        name: "deepseek",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "DeepSeek",
        defaultModel: "deepseek-chat"
      }
    );

    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                message:
                  "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
                type: "invalid_request_error"
              }
            }),
            { status: 400 }
          )
        );
      })
    );

    await expect(
      provider.generate({
        ...createProviderInput(),
        onTextDelta: () => {
          throw new Error("invalid_request should not stream text");
        }
      })
    ).rejects.toMatchObject({ category: "invalid_request" });

    expect(requestModes).toEqual([true]);
  });

  it("maps Anthropic-compatible responses into the unified provider response shape", async () => {
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
        anthropicVersion: "2023-06-01",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultDisplayName: "Anthropic",
        defaultModel: "claude-sonnet-4-20250514"
      }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            content: [
              {
                text: "Need a tool.",
                type: "text"
              },
              {
                id: "call-1",
                input: {
                  path: "README.md"
                },
                name: "read_file",
                type: "tool_use"
              }
            ],
            id: "msg-1",
            model: "claude-sonnet-4-20250514",
            stop_reason: "tool_use",
            type: "message",
            usage: {
              input_tokens: 10,
              output_tokens: 4
            }
          }),
          {
            status: 200
          }
        )
      )
    );

    const response = await provider.generate(createProviderInput());

    expect(response.kind).toBe("tool_calls");
    if (response.kind !== "tool_calls") {
      throw new Error("Expected tool call response.");
    }

    expect(response.message).toBe("Need a tool.");
    expect(response.toolCalls[0]).toEqual({
      input: {
        path: "README.md"
      },
      raw: {
        index: 1
      },
      reason: "Provider read_file tool call requested.",
      toolCallId: "call-1",
      toolName: "read_file"
    });
    expect(response.metadata?.providerName).toBe("anthropic");
    expect(response.metadata?.modelName).toBe("claude-sonnet-4-20250514");
    expect(response.usage.totalTokens).toBe(14);
  });

  it("streams Anthropic-compatible text deltas into the final response", async () => {
    const encoder = new TextEncoder();
    const provider = new AnthropicCompatibleProvider(
      {
        apiKey: "anthropic-test-key",
        baseUrl: "https://anthropic.example.test",
        maxRetries: 0,
        model: "claude-sonnet-4-20250514",
        name: "anthropic",
        streamIdleTimeoutMs: 5_000,
        timeoutMs: 5_000
      },
      {
        anthropicVersion: "2023-06-01",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultDisplayName: "Anthropic",
        defaultModel: "claude-sonnet-4-20250514"
      }
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    [
                      'data: {"type":"message_start","message":{"id":"msg-stream","model":"claude-sonnet-4-20250514","usage":{"input_tokens":6,"output_tokens":0}}}',
                      "",
                      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
                      "",
                      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}',
                      "",
                      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream"}}',
                      "",
                      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
                      ""
                    ].join("\n")
                  )
                );
                controller.close();
              }
            }),
            { status: 200 }
          )
        )
      )
    );
    const deltas: string[] = [];
    const input = createProviderInput("stream anthopic");
    input.onTextDelta = (delta) => deltas.push(delta);

    const response = await provider.generate(input);

    expect(response.kind).toBe("final");
    expect(response.message).toBe("hello stream");
    expect(deltas).toEqual(["hello ", "stream"]);
    expect(response.usage).toMatchObject({ inputTokens: 6, outputTokens: 2, totalTokens: 8 });
  });

  it("falls back when an Anthropic-compatible stream goes idle before progress", async () => {
    const provider = new AnthropicCompatibleProvider(
      {
        apiKey: "anthropic-test-key",
        baseUrl: "https://anthropic.example.test",
        maxRetries: 0,
        model: "claude-sonnet-4-20250514",
        name: "anthropic",
        streamIdleTimeoutMs: 5,
        timeoutMs: 5_000
      },
      {
        anthropicVersion: "2023-06-01",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultDisplayName: "Anthropic",
        defaultModel: "claude-sonnet-4-20250514"
      }
    );
    const requestModes: Array<boolean | undefined> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as { stream?: boolean };
        requestModes.push(body.stream);
        if (body.stream === true) {
          return Promise.resolve(
            new Response(new ReadableStream<Uint8Array>({ pull() {} }), { status: 200 })
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: [
                {
                  text: "anthropic idle fallback",
                  type: "text"
                }
              ],
              id: "msg-idle-fallback",
              model: "claude-sonnet-4-20250514",
              stop_reason: "end_turn",
              type: "message",
              usage: {
                input_tokens: 5,
                output_tokens: 2
              }
            }),
            { status: 200 }
          )
        );
      })
    );

    const response = await provider.generate({
      ...createProviderInput("stream anthropic idle"),
      onTextDelta: () => {}
    });

    expect(response.kind).toBe("final");
    expect(response.message).toBe("anthropic idle fallback");
    expect(requestModes).toEqual([true, undefined]);
  });

  it("maps provider failures into unified provider errors", async () => {
    const provider = new GlmProvider(createGlmConfig({
      apiKey: "glm-test-key",
      baseUrl: "https://glm.example.test/v4"
    }));

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        new Response(
          JSON.stringify({
            error: {
              message: "invalid api key",
              type: "authentication_error"
            }
          }),
          {
            status: 401
          }
        )
      )
    );

    await expect(provider.generate(createProviderInput())).rejects.toMatchObject({
      category: "auth_error",
      providerName: "glm"
    } satisfies Partial<ProviderError>);
  });

  it("reports provider test and doctor diagnostics", async () => {
    const workspaceRoot = await createTempWorkspace();
    const server = createServer((request, response) => {
      if (request.url === "/v4/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "glm-4.5-air" }] }));
        return;
      }

      response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP server address.");
    }

    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        provider: {
          builtinProviderName: "glm",
          apiKey: "glm-test-key",
          baseUrl: `http://127.0.0.1:${address.port}/v4`,
          configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
          configSource: "env",
          displayName: "GLM",
          family: "openai-compatible",
          maxRetries: 1,
          model: "glm-4.5-air",
          name: "glm",
          timeoutMs: 5_000,
          transport: "openai-compatible"
        }
      }
    });

    try {
      const testReport = await handle.service.testCurrentProvider();
      const doctorReport = await handle.service.configDoctor();

      expect(testReport.ok).toBe(true);
      expect(testReport.endpointReachable).toBe(true);
      expect(testReport.modelAvailable).toBe(true);
      expect(doctorReport.apiKeyConfigured).toBe(true);
      expect(doctorReport.endpointReachable).toBe(true);
      expect(doctorReport.modelConfigured).toBe(true);
      expect(doctorReport.shellBackend).toBe("default");
      expect(doctorReport.shellBackendAvailable).toBe(true);
      expect(doctorReport.shellExecutable.length).toBeGreaterThan(0);
      expect(doctorReport.shellMaxTimeoutMs).toBeGreaterThan(0);
      expect(doctorReport.issues).toEqual([]);
      expect(doctorReport.workspaceSecretFindings).toEqual([]);
    } finally {
      handle.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("fetchContextWindow reads context_length from /models", async () => {
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            data: [{ id: "astron-code-latest", context_length: 96_000 }]
          })
        );
        return;
      }

      response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP server address.");
    }

    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "compat-test-key",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        maxRetries: 0,
        model: "astron-code-latest",
        name: "xfyun-coding",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "iFLYTEK Coding Plan",
        defaultModel: "astron-code-latest"
      }
    );

    try {
      const tokens = await provider.fetchContextWindow?.();
      expect(tokens).toBe(96_000);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("fetchContextWindow falls back to Ollama /api/show", async () => {
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "llama3.2" }] }));
        return;
      }

      if (request.url === "/api/show" && request.method === "POST") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model_info: {
              "llama.context_length": 131_072
            }
          })
        );
        return;
      }

      response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP server address.");
    }

    const provider = new OpenAiCompatibleProvider(
      {
        apiKey: "ollama",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        maxRetries: 0,
        model: "llama3.2",
        name: "ollama",
        timeoutMs: 5_000
      },
      {
        defaultBaseUrl: null,
        defaultDisplayName: "Ollama",
        defaultModel: "llama3.2"
      }
    );

    try {
      const tokens = await provider.fetchContextWindow?.();
      expect(tokens).toBe(131_072);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined && error !== null) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("createApplicationAsync applies provider API context window", async () => {
    class ApiContextProvider implements Provider {
      public readonly model = "api-model";
      public readonly name = "api-provider";

      public fetchContextWindow(): Promise<number | null> {
        return Promise.resolve(200_000);
      }

      public generate(): Promise<ProviderResponse> {
        return Promise.resolve({
          kind: "final",
          message: "ok",
          metadata: {
            modelName: this.model,
            providerName: this.name,
            retryCount: 0
          },
          usage: {
            inputTokens: 1,
            outputTokens: 1
          }
        });
      }
    }

    const workspaceRoot = await createTempWorkspace();
    const handle = await createApplicationAsync(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        provider: {
          apiKey: "test-key",
          baseUrl: "https://example.test/v1",
          builtinProviderName: "mock",
          configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
          configSource: "env",
          configured: true,
          contextWindowSource: "provider_manifest",
          contextWindowTokens: 64_000,
          displayName: "Mock Provider",
          family: "mock",
          maxRetries: 0,
          model: "api-model",
          name: "mock",
          streamIdleTimeoutMs: 5_000,
          streamIdleTimeoutConfigured: false,
          timeoutConfigured: false,
          timeoutMs: 5_000,
          transport: "mock"
        },
        tokenBudget: {
          outputLimit: 8_000,
          reservedOutput: 1_000,
          usedInput: 0,
          usedOutput: 0,
          usedCostUsd: 0
        }
      },
      provider: new ApiContextProvider()
    });

    try {
      expect(handle.config.provider.contextWindowSource).toBe("provider_api");
      expect(handle.config.provider.contextWindowTokens).toBe(200_000);
      expect(handle.config.tokenBudget.inputLimit).toBe(200_000);
    } finally {
      handle.close();
    }
  });

  it("warns when workspace provider config contains plaintext secrets", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "glm",
        providers: {
          glm: {
            apiKey: "workspace-secret-value",
            model: "glm-4.5-air"
          }
        }
      }),
      "utf8"
    );
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        provider: {
          builtinProviderName: "glm",
          apiKey: "glm-test-key",
          baseUrl: "https://glm.example.test/v4",
          configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
          configSource: "env",
          displayName: "GLM",
          family: "openai-compatible",
          maxRetries: 1,
          model: "glm-4.5-air",
          name: "glm",
          streamIdleTimeoutMs: 300_000,
          timeoutMs: 120_000,
          transport: "openai-compatible"
        }
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "ok",
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    });

    try {
      const doctorReport = await handle.service.configDoctor();

      expect(doctorReport.workspaceSecretFindings).toEqual([
        {
          fields: ["providers.glm.apiKey"],
          file: "provider.config.json"
        }
      ]);
      expect(doctorReport.issues.join("\n")).toContain("Workspace config provider.config.json contains provider secret fields");
      expect(doctorReport.issues.join("\n")).not.toContain("workspace-secret-value");
    } finally {
      handle.close();
    }
  });

  it("warns when configured test timeout exceeds shell timeout limit", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        workflow: {
          maxShellTimeoutMs: 10_000,
          testCommands: [
            {
              command: "npm test",
              name: "test",
              timeoutMs: 20_000
            }
          ]
        }
      }),
      "utf8"
    );
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        provider: {
          apiKey: null,
          configPath: join(workspaceRoot, ".auto-talon", "provider.config.json"),
          configSource: "defaults",
          displayName: "Mock",
          family: "mock",
          maxRetries: 0,
          model: "mock-model",
          name: "mock",
          streamIdleTimeoutMs: 300_000,
          timeoutMs: 120_000,
          transport: "mock"
        }
      },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: "ok",
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    });

    try {
      const doctorReport = await handle.service.configDoctor();

      expect(doctorReport.shellMaxTimeoutMs).toBe(10_000);
      expect(doctorReport.issues.join("\n")).toContain(
        "Configured test command test timeout 20000ms exceeds workflow.maxShellTimeoutMs 10000ms"
      );
    } finally {
      handle.close();
    }
  });

  it("records provider trace events and unified provider errors at runtime", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider((input) => {
        if (input.task.input === "fail provider") {
          throw new ProviderError({
            category: "rate_limit",
            message: "provider throttled",
            modelName: "scripted-model",
            providerName: "scripted-provider",
            retriable: true,
            summary: "provider throttled"
          });
        }

        return {
          kind: "final",
          message: "provider success",
          metadata: {
            modelName: "scripted-model",
            providerName: "scripted-provider",
            retryCount: 1
          },
          usage: {
            inputTokens: 12,
            outputTokens: 6,
            totalTokens: 18
          }
        };
      })
    });

    try {
      const succeeded = await handle.service.runTask(
        createDefaultRunOptions("provider success", workspaceRoot, handle.config)
      );
      const failed = await handle.service.runTask(
        createDefaultRunOptions("fail provider", workspaceRoot, handle.config)
      );

      const successTrace = handle.service.traceTask(succeeded.task.taskId);
      const failedTrace = handle.service.traceTask(failed.task.taskId);

      expect(
        successTrace.some((event) => event.eventType === "provider_request_started")
      ).toBe(true);
      expect(
        successTrace.some(
          (event) =>
            event.eventType === "provider_request_succeeded" &&
            event.payload.providerName === "scripted-provider"
        )
      ).toBe(true);
      expect(
        failedTrace.some(
          (event) =>
            event.eventType === "provider_request_failed" &&
            event.payload.errorCategory === "rate_limit" &&
            event.payload.retryCount === 0
        )
      ).toBe(true);
      expect(failed.error?.code).toBe("provider_error");
      expect(failed.error?.details?.providerCategory).toBe("rate_limit");
      expect(handle.service.providerStats()?.failedRequests).toBe(1);
      expect(handle.service.providerStats()?.successfulRequests).toBe(1);
    } finally {
      handle.close();
    }
  }, 30_000);
});

function createProviderInput(): ProviderInput {
  return {
    agentProfileId: "executor",
    availableTools: [
      {
        capability: "filesystem.read",
        description: "Read files from the workspace.",
        inputSchema: {
          properties: {
            path: {
              type: "string"
            }
          },
          required: ["path"],
          type: "object"
        },
        name: "read_file",
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
        content: "Read the README file.",
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
      input: "Read the README file.",
      maxIterations: 4,
      metadata: {},
      providerName: "glm",
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

function createGlmConfig(
  overrides: Partial<ProviderConfig>
): ProviderConfig {
  return {
    apiKey: "glm-test-key",
    baseUrl: "https://glm.example.test/v4",
    maxRetries: 0,
    model: "glm-4.5-air",
    name: "glm",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 5_000,
    ...overrides
  };
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-provider-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
