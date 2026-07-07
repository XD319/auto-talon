import { afterEach, describe, expect, it, vi } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import {
  BraveWebSearchClient,
  DdgsWebSearchClient,
  ExaWebSearchClient,
  FirecrawlWebSearchClient,
  SearxngWebSearchClient,
  TavilyWebSearchClient,
  WebSearchTool
} from "../src/tools/web-search-tool.js";
import type { WebRuntimeConfig, WebSearchRuntimeConfig } from "../src/runtime/runtime-config.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("WebSearchTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is unavailable when Firecrawl has no API key", () => {
    const tool = new WebSearchTool(createSandbox(), {
      ...createConfig(),
      apiKey: null,
      backend: "firecrawl"
    });

    expect(tool.checkAvailability().available).toBe(false);
  });

  it("is available when Firecrawl is configured", () => {
    const tool = new WebSearchTool(createSandbox(), createFullWebConfig());
    expect(tool.checkAvailability()).toEqual({
      available: true,
      reason: "web_search backend firecrawl is configured"
    });
  });

  it("executes successfully through the tool wrapper", async () => {
    const tool = new WebSearchTool(createSandbox(), createFullWebConfig(), {
      backend: "firecrawl",
      requiresApiKey: true,
      search: () => Promise.resolve({
        provider: "firecrawl",
        query: "ai news",
        results: [
          {
            snippet: "Snippet",
            title: "News",
            url: "https://example.com/news"
          }
        ]
      })
    });
    const prepared = tool.prepare({ query: "ai news" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected web_search success.");
    }
    expect(result.summary).toBe("Found 1 web results for ai news");
    expect(result.artifacts?.[0]?.artifactType).toBe("web_search_results");
    expect(result.output).toMatchObject({
      provider: "firecrawl",
      query: "ai news"
    });
    expect((result.output.results as Array<{ citation?: unknown }>)[0]?.citation).toMatchObject({
      citationId: "search:1",
      citedText: "Snippet",
      source: "firecrawl",
      title: "News",
      url: "https://example.com/news"
    });
  });

  it("executes built-in ddgs through the tool wrapper using VQD flow", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const urlStr = formatRequestUrl(url);
        if (urlStr.includes("links.duckduckgo.com")) {
          return Promise.resolve(
            new Response(
              'DDG.pageLayout.load(\'d\',[{"u":"https://ros.org","t":"ROS 2","a":"Robot Operating System"}]);',
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response('<html>vqd="4-token"</html>', { status: 200 })
        );
      })
    );

    const tool = new WebSearchTool(
      new SandboxService({
        allowedFetchHosts: ["*"],
        workspaceRoot: process.cwd()
      }),
      {
        ...createFullWebConfig(),
        searchBackend: "ddgs"
      }
    );
    const prepared = tool.prepare({ query: "ROS2" }, createContext());
    expect(prepared.preparedInput.plan.url).toContain("bing.com");

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected built-in ddgs web_search success.");
    }
    expect(result.output).toMatchObject({
      provider: "ddgs",
      query: "ROS2",
      results: [
        {
          snippet: "Robot Operating System",
          title: "ROS 2",
          url: "https://ros.org"
        }
      ]
    });
  });

  it("normalizes Firecrawl search results", async () => {
    let requestInit: RequestInit | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        requestInit = init ?? null;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  description: "Fresh result",
                  publishedDate: "2026-05-01",
                  title: "AI News",
                  url: "https://example.com/news"
                }
              ]
            }),
            { status: 200 }
          )
        );
      })
    );

    const client = new FirecrawlWebSearchClient();
    const result = await client.search({
      apiKey: "key",
      apiUrl: "https://api.firecrawl.dev/v1/search",
      domains: ["example.com"],
      maxResults: 3,
      query: "ai news",
      recencyDays: 7,
      signal: new AbortController().signal
    });

    expect(requestInit?.method).toBe("POST");
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      filter: { domains: ["example.com"] },
      limit: 3,
      query: "ai news",
      tbs: "qdr:d7"
    });
    expect(result).toEqual({
      provider: "firecrawl",
      query: "ai news",
      results: [
        {
          publishedAt: "2026-05-01",
          snippet: "Fresh result",
          title: "AI News",
          url: "https://example.com/news"
        }
      ]
    });
  });

  it("returns tool_execution_error when the provider fails", async () => {
    const tool = new WebSearchTool(createSandbox(), createConfig(), {
      search: () => {
        throw new Error("provider down");
      }
    });
    const prepared = tool.prepare({ query: "ai news" }, createContext());

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected web_search to return a failure result.");
    }
    expect(result.errorCode).toBe("tool_execution_error");
    expect(result.errorMessage).toBe("provider down");
  });

  it("blocks illegal provider endpoints through the sandbox", () => {
    const tool = new WebSearchTool(createSandbox(), {
      ...createConfig(),
      apiUrl: "http://127.0.0.1:8080/search"
    });

    expect(() => tool.prepare({ query: "private" }, createContext())).toThrow(/blocked for web fetch/u);
  });

  it("rejects allowed and blocked domains together", () => {
    const tool = new WebSearchTool(createSandbox(), createConfig());

    expect(() =>
      tool.prepare(
        {
          allowedDomains: ["example.com"],
          blockedDomains: ["bad.example"],
          query: "ai news"
        },
        createContext()
      )
    ).toThrow(/mutually exclusive/u);
  });

  it("normalizes search responses across configured providers", async () => {
    const calls: Array<{ body: unknown; headers: HeadersInit | undefined; method: string | undefined; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          body: parseRequestBody(init?.body),
          headers: init?.headers,
          method: init?.method,
          url: formatRequestUrl(url)
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  content: "Result text",
                  title: "Result",
                  url: "https://example.com/page"
                }
              ],
              web: {
                results: [
                  {
                    description: "Brave text",
                    title: "Brave",
                    url: "https://example.com/brave"
                  }
                ]
              }
            }),
            { status: 200 }
          )
        );
      })
    );

    await new TavilyWebSearchClient().search({
      apiKey: "tavily-key",
      apiUrl: "https://api.tavily.com/search",
      blockedDomains: ["blocked.example"],
      maxResults: 2,
      query: "docs",
      signal: new AbortController().signal
    });
    await new ExaWebSearchClient().search({
      allowedDomains: ["example.com"],
      apiKey: "exa-key",
      apiUrl: "https://api.exa.ai/search",
      maxResults: 2,
      query: "docs",
      signal: new AbortController().signal
    });
    await new BraveWebSearchClient().search({
      apiKey: "brave-key",
      apiUrl: "https://api.search.brave.com/res/v1/web/search",
      maxResults: 2,
      query: "docs",
      signal: new AbortController().signal
    });
    const searxng = await new SearxngWebSearchClient().search({
      apiKey: null,
      apiUrl: "https://search.example/search",
      maxResults: 2,
      query: "docs",
      signal: new AbortController().signal
    });

    expect(calls[0]?.body).toMatchObject({
      api_key: "tavily-key",
      exclude_domains: ["blocked.example"],
      max_results: 2,
      query: "docs"
    });
    expect(calls[1]?.headers).toMatchObject({ "x-api-key": "exa-key" });
    expect(calls[2]?.url).toContain("q=docs");
    expect(calls[3]?.url).toContain("format=json");
    expect(calls[3]?.url).toContain("limit=2");
    expect(searxng.results[0]?.url).toBe("https://example.com/page");
  });

  it("normalizes DDGS search responses and sends limit query param", async () => {
    let requestUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        requestUrl = formatRequestUrl(url);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  content: "DDGS result",
                  title: "DDGS",
                  url: "https://example.com/ddgs"
                }
              ]
            }),
            { status: 200 }
          )
        );
      })
    );

    const result = await new DdgsWebSearchClient().search({
      apiKey: null,
      apiUrl: "https://ddgs.example/search",
      maxResults: 4,
      query: "docs",
      signal: new AbortController().signal
    });

    expect(requestUrl).toContain("limit=4");
    expect(result.results[0]?.url).toBe("https://example.com/ddgs");
  });

  it("uses VQD + links API for built-in ddgs when apiUrl is not configured", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const urlStr = formatRequestUrl(url);
        calls.push(urlStr);
        if (urlStr.includes("duckduckgo.com/") && !urlStr.includes("links.")) {
          return Promise.resolve(
            new Response('<html>vqd="4-test-token"</html>', {
              status: 200,
              headers: {}
            })
          );
        }
        if (urlStr.includes("links.duckduckgo.com")) {
          return Promise.resolve(
            new Response(
              'DDG.pageLayout.load(\'d\',[{"u":"https://example.com/result","t":"Test Result","a":"A test snippet"}]);',
              { status: 200 }
            )
          );
        }
        return Promise.resolve(new Response("", { status: 404 }));
      })
    );

    const result = await new DdgsWebSearchClient().search({
      apiKey: null,
      apiUrl: null,
      maxResults: 3,
      query: "docs",
      signal: new AbortController().signal
    });

    expect(calls[0]).toContain("duckduckgo.com");
    expect(calls[1]).toContain("links.duckduckgo.com");
    expect(calls[1]).toContain("vqd=4-test-token");
    expect(result.provider).toBe("ddgs");
    expect(result.results[0]?.url).toBe("https://example.com/result");
    expect(result.results[0]?.title).toBe("Test Result");
    expect(result.results[0]?.snippet).toBe("A test snippet");
  });

  it("falls back to HTML scraping when links API returns JS challenge", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const urlStr = formatRequestUrl(url);
        if (urlStr.includes("links.duckduckgo.com")) {
          return Promise.resolve(
            new Response('let jsa = 318; DDG.deep.initialize("challenge");', { status: 202 })
          );
        }
        if (urlStr.includes("html.duckduckgo.com")) {
          return Promise.resolve(
            new Response(
              [
                '<div class="result">',
                '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffallback">Fallback</a>',
                '<div class="result__snippet">HTML fallback snippet</div>',
                "</div>"
              ].join(""),
              { status: 200 }
            )
          );
        }
        return Promise.resolve(
          new Response('<html>vqd="4-token"</html>', { status: 200 })
        );
      })
    );

    const result = await new DdgsWebSearchClient().search({
      apiKey: null,
      apiUrl: null,
      maxResults: 3,
      query: "docs",
      signal: new AbortController().signal
    });

    expect(result.provider).toBe("ddgs");
    expect(result.results[0]?.url).toBe("https://example.com/fallback");
  });

  it("falls back to Bing when DuckDuckGo returns CAPTCHA", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const urlStr = formatRequestUrl(url);
        if (urlStr.includes("bing.com/search")) {
          return Promise.resolve(
            new Response(
              [
                '<li class="b_algo">',
                '<h2><a href="https://example.com/rag">RAG Guide</a></h2>',
                '<div class="b_caption"><p>Retrieval augmented generation overview</p></div>',
                "</li>"
              ].join(""),
              { status: 200 }
            )
          );
        }
        if (urlStr.includes("links.duckduckgo.com")) {
          return Promise.resolve(new Response("let jsa = 1;", { status: 202 }));
        }
        if (urlStr.includes("html.duckduckgo.com")) {
          return Promise.resolve(
            new Response('<div class="anomaly-modal">CAPTCHA</div><form id="challenge-form"></form>', { status: 202 })
          );
        }
        return Promise.resolve(
          new Response('<html>vqd="4-token"</html>', { status: 200 })
        );
      })
    );

    const result = await new DdgsWebSearchClient().search({
      apiKey: null,
      apiUrl: null,
      maxResults: 3,
      query: "RAG pipeline",
      signal: new AbortController().signal
    });

    expect(result.provider).toBe("bing");
    expect(result.results[0]?.url).toBe("https://example.com/rag");
    expect(result.results[0]?.title).toBe("RAG Guide");
    expect(result.attempts?.map((attempt) => attempt.step)).toEqual([
      "ddg_vqd",
      "ddg_links",
      "ddg_html",
      "bing"
    ]);
    expect(result.attempts?.[2]).toMatchObject({
      status: "failed",
      step: "ddg_html"
    });
    expect(result.attempts?.[3]).toMatchObject({
      resultCount: 1,
      status: "succeeded",
      step: "bing"
    });
  });

  it("throws when built-in DuckDuckGo and Bing both fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        const urlStr = formatRequestUrl(url);
        if (urlStr.includes("bing.com/search")) {
          return Promise.resolve(new Response("<html></html>", { status: 200 }));
        }
        if (urlStr.includes("links.duckduckgo.com")) {
          return Promise.resolve(new Response("let jsa = 1;", { status: 202 }));
        }
        if (urlStr.includes("html.duckduckgo.com")) {
          return Promise.resolve(
            new Response('<div class="anomaly-modal">CAPTCHA</div><form id="challenge-form"></form>', { status: 202 })
          );
        }
        return Promise.resolve(
          new Response('<html>vqd="4-token"</html>', { status: 200 })
        );
      })
    );

    await expect(
      new DdgsWebSearchClient().search({
        apiKey: null,
        apiUrl: null,
        maxResults: 3,
        query: "docs",
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/Built-in web search failed/);
  });

  it("post-filters results using the domains alias", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { title: "Allowed", url: "https://allowed.example/page", content: "ok" },
                { title: "Blocked", url: "https://blocked.example/page", content: "no" }
              ]
            }),
            { status: 200 }
          )
        )
      )
    );

    const result = await new SearxngWebSearchClient().search({
      apiKey: null,
      apiUrl: "https://search.example/search",
      domains: ["allowed.example"],
      maxResults: 5,
      query: "docs",
      signal: new AbortController().signal
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe("https://allowed.example/page");
  });

  it("adds citations only after domain filtering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              results: [
                { title: "Allowed", url: "https://allowed.example/page", content: "Allowed snippet" },
                { title: "Blocked", url: "https://blocked.example/page", content: "Blocked snippet" }
              ]
            }),
            { status: 200 }
          )
        )
      )
    );

    const tool = new WebSearchTool(
      new SandboxService({
        allowedFetchHosts: ["search.example"],
        workspaceRoot: process.cwd()
      }),
      {
        ...createFullWebConfig(),
        providers: {
          ...createFullWebConfig().providers,
          searxng: { apiKey: null, apiKeyEnv: null, apiUrl: "https://search.example/search" }
        },
        searchBackend: "searxng"
      }
    );

    const prepared = tool.prepare(
      {
        allowedDomains: ["allowed.example"],
        query: "docs"
      },
      createContext()
    );
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected filtered search success.");
    }
    const output = result.output as {
      results: Array<{ citation?: { url: string }; url: string }>;
    };
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.url).toBe("https://allowed.example/page");
    expect(output.results[0]?.citation?.url).toBe("https://allowed.example/page");
  });

  it("maps recencyDays for Tavily and Brave clients", async () => {
    const calls: Array<{ body: unknown; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          body: parseRequestBody(init?.body),
          url: formatRequestUrl(url)
        });
        return Promise.resolve(
          new Response(JSON.stringify({ results: [] }), { status: 200 })
        );
      })
    );

    await new TavilyWebSearchClient().search({
      apiKey: "tavily-key",
      apiUrl: "https://api.tavily.com/search",
      maxResults: 2,
      query: "docs",
      recencyDays: 14,
      signal: new AbortController().signal
    });
    await new BraveWebSearchClient().search({
      apiKey: "brave-key",
      apiUrl: "https://api.search.brave.com/res/v1/web/search",
      maxResults: 2,
      query: "docs",
      recencyDays: 3,
      signal: new AbortController().signal
    });

    expect(calls[0]?.body).toMatchObject({ days: 14 });
    expect(calls[1]?.url).toContain("freshness=pw");
  });

  it("falls back from ddgs to a configured API backend when built-in search fails", async () => {
    const tool = new WebSearchTool(
      new SandboxService({
        allowedFetchHosts: ["*"],
        workspaceRoot: process.cwd()
      }),
      {
        backend: "auto",
        extractBackend: "http",
        longPageThresholdBytes: 64_000,
        maxResults: 5,
        providers: {
          brave: {
            apiKey: "brave-key",
            apiKeyEnv: "BRAVE_SEARCH_API_KEY",
            apiUrl: "https://api.search.brave.com/res/v1/web/search"
          },
          ddgs: { apiKey: null, apiKeyEnv: null, apiUrl: null },
          exa: { apiKey: null, apiKeyEnv: "EXA_API_KEY", apiUrl: null },
          firecrawl: { apiKey: null, apiKeyEnv: "FIRECRAWL_API_KEY", apiUrl: null },
          searxng: { apiKey: null, apiKeyEnv: null, apiUrl: null },
          tavily: { apiKey: null, apiKeyEnv: "TAVILY_API_KEY", apiUrl: null }
        },
        searchBackend: "ddgs",
        summaryTargetBytes: 5_000
      },
      new Map([
        [
          "ddgs",
          {
            backend: "ddgs",
            requiresApiKey: false,
            search: () => Promise.reject(new Error("Built-in web search failed"))
          }
        ],
        [
          "brave",
          {
            backend: "brave",
            requiresApiKey: true,
            search: () =>
              Promise.resolve({
                provider: "brave",
                query: "docs",
                results: [
                  {
                    snippet: "Brave snippet",
                    title: "Brave result",
                    url: "https://example.com/brave"
                  }
                ]
              })
          }
        ]
      ])
    );

    const prepared = tool.prepare({ query: "docs" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected fallback web_search success.");
    }
    expect(result.output).toMatchObject({ provider: "brave" });
    expect(result.details).toMatchObject({
      fallbackFrom: "ddgs",
      requestedBackend: "ddgs"
    });
  });

  it("returns remediation when ddgs and configured API backends all fail", async () => {
    const tool = new WebSearchTool(
      new SandboxService({
        allowedFetchHosts: ["*"],
        workspaceRoot: process.cwd()
      }),
      {
        backend: "auto",
        extractBackend: "http",
        longPageThresholdBytes: 64_000,
        maxResults: 5,
        providers: {
          brave: {
            apiKey: "brave-key",
            apiKeyEnv: "BRAVE_SEARCH_API_KEY",
            apiUrl: "https://api.search.brave.com/res/v1/web/search"
          },
          ddgs: { apiKey: null, apiKeyEnv: null, apiUrl: null },
          exa: { apiKey: null, apiKeyEnv: "EXA_API_KEY", apiUrl: null },
          firecrawl: { apiKey: null, apiKeyEnv: "FIRECRAWL_API_KEY", apiUrl: null },
          searxng: { apiKey: null, apiKeyEnv: null, apiUrl: null },
          tavily: { apiKey: null, apiKeyEnv: "TAVILY_API_KEY", apiUrl: null }
        },
        searchBackend: "ddgs",
        summaryTargetBytes: 5_000
      },
      new Map([
        [
          "ddgs",
          {
            backend: "ddgs",
            requiresApiKey: false,
            search: () => Promise.reject(new Error("Built-in web search failed"))
          }
        ],
        [
          "brave",
          {
            backend: "brave",
            requiresApiKey: true,
            search: () => Promise.reject(new Error("Brave failed"))
          }
        ]
      ])
    );

    const prepared = tool.prepare({ query: "docs" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected web_search failure.");
    }
    expect(result.details?.remediation).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("does not fall back to ddgs when an explicit API backend fails", async () => {
    const tool = new WebSearchTool(
      new SandboxService({
        allowedFetchHosts: ["api.search.brave.com"],
        workspaceRoot: process.cwd()
      }),
      {
        ...createFullWebConfig(),
        providers: {
          ...createFullWebConfig().providers,
          brave: {
            apiKey: "brave-key",
            apiKeyEnv: "BRAVE_SEARCH_API_KEY",
            apiUrl: "https://api.search.brave.com/res/v1/web/search"
          }
        },
        searchBackend: "brave"
      },
      {
        backend: "brave",
        requiresApiKey: true,
        search: () => Promise.reject(new Error("Brave unavailable"))
      }
    );
    const prepared = tool.prepare({ query: "docs" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected brave failure.");
    }
    expect(result.errorMessage).toContain("Brave unavailable");
    expect(result.details?.provider).toBe("brave");
  });
});

function createSandbox(): SandboxService {
  return new SandboxService({
    allowedFetchHosts: ["api.firecrawl.dev"],
    workspaceRoot: process.cwd()
  });
}

function createConfig(): WebSearchRuntimeConfig {
  return {
    apiKey: "key",
    apiKeyEnv: "FIRECRAWL_API_KEY",
    apiUrl: "https://api.firecrawl.dev/v1/search",
    backend: "firecrawl",
    maxResults: 5
  };
}

function createFullWebConfig(): WebRuntimeConfig {
  return {
    backend: "firecrawl",
    extractBackend: "http",
    longPageThresholdBytes: 64_000,
    maxResults: 5,
    providers: {
      brave: { apiKey: null, apiKeyEnv: "BRAVE_SEARCH_API_KEY", apiUrl: null },
      ddgs: { apiKey: null, apiKeyEnv: null, apiUrl: null },
      exa: { apiKey: null, apiKeyEnv: "EXA_API_KEY", apiUrl: null },
      firecrawl: {
        apiKey: "key",
        apiKeyEnv: "FIRECRAWL_API_KEY",
        apiUrl: "https://api.firecrawl.dev/v1/search"
      },
      searxng: { apiKey: null, apiKeyEnv: null, apiUrl: null },
      tavily: { apiKey: null, apiKeyEnv: "TAVILY_API_KEY", apiUrl: null }
    },
    searchBackend: "firecrawl",
    summaryTargetBytes: 5_000
  };
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  return typeof body === "string" ? JSON.parse(body) : null;
}

function formatRequestUrl(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }
  if (url instanceof URL) {
    return url.href;
  }
  return url.url;
}

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-web-search-test",
    userId: "test-user",
    workspaceRoot: process.cwd()
  };
}
