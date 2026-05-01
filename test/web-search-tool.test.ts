import { afterEach, describe, expect, it, vi } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FirecrawlWebSearchClient, WebSearchTool } from "../src/tools/web-search-tool.js";
import type { WebSearchRuntimeConfig } from "../src/runtime/runtime-config.js";
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
      query: "ai news"
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
