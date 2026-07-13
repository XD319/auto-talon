import { describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { FirecrawlWebExtractClient, TavilyWebExtractClient, ExaWebExtractClient, WebFetchTool } from "../src/tools/web-fetch-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";
import type { WebRuntimeConfig } from "../src/runtime/runtime-config.js";

describe("WebFetchTool", () => {
  it("keeps public page content visible to the model", () => {
    const sandbox = new SandboxService({ allowedFetchHosts: ["*"], workspaceRoot: process.cwd() });
    expect(new WebFetchTool(sandbox).privacyLevel).toBe("public");
  });
  it("uses manual redirect mode to prevent host-allowlist bypass via redirects", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    let requestInit: RequestInit | null = null;
    const tool = new WebFetchTool(sandboxService, {
      fetch: (_input, init) => {
        requestInit = init;
        return new Response("ok", {
          status: 200
        });
      }
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/page"
      },
      createContext()
    );

    await tool.execute(prepared.preparedInput, createContext());
    expect(requestInit?.redirect).toBe("manual");
  });

  it("returns non-ok upstream HTTP status as a readable response", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(sandboxService, {
      fetch: () =>
        new Response("not found", {
          status: 404
        })
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/missing"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected web_extract to return an HTTP response result.");
    }
    const output = result.output as {
      body: string;
      ok: boolean;
      status: number;
    };
    expect(output.ok).toBe(false);
    expect(output.status).toBe(404);
    expect(output.body).toBe("not found");
    expect(result.summary).toContain("HTTP 404");
  });

  it("returns tool_execution_error with cause details when the network request fails", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["missing.example.com"],
      workspaceRoot: process.cwd()
    });
    const networkCause = Object.assign(new Error("getaddrinfo ENOTFOUND missing.example.com"), {
      code: "ENOTFOUND"
    });
    const tool = new WebFetchTool(sandboxService, {
      fetch: () => {
        throw new TypeError("fetch failed", {
          cause: networkCause
        });
      }
    });

    const prepared = tool.prepare(
      {
        url: "https://missing.example.com/page"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected web_extract to return a network failure result.");
    }
    expect(result.errorCode).toBe("tool_execution_error");
    expect(result.errorMessage).toContain("Web fetch network failed");
    expect(result.errorMessage).toContain("fetch failed");
    expect(result.details?.url).toBe("https://missing.example.com/page");
    expect(result.details?.cause).toMatchObject({
      causeMessage: "getaddrinfo ENOTFOUND missing.example.com",
      code: "ENOTFOUND",
      message: "fetch failed",
      name: "TypeError"
    });
  });

  it("follows allowed redirects", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com", "*.example.com"],
      workspaceRoot: process.cwd()
    });

    let callCount = 0;
    const tool = new WebFetchTool(sandboxService, {
      fetch: () => {
        callCount += 1;
        if (callCount === 1) {
          return new Response("", {
            headers: {
              location: "https://docs.example.com/final"
            },
            status: 302
          });
        }
        return new Response("final body", {
          status: 200
        });
      }
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/start"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected redirect flow to succeed.");
    }
    const output = result.output as {
      redirectTrace: Array<{ status: number; url: string }>;
      url: string;
    };
    expect(output.redirectTrace).toHaveLength(2);
    expect(output.redirectTrace[1]?.url).toBe("https://docs.example.com/final");
  });

  it("rejects redirects to disallowed hosts", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(sandboxService, {
      fetch: () =>
        new Response("", {
          headers: {
            location: "https://evil.com/final"
          },
          status: 302
        })
    });

    const prepared = tool.prepare({ url: "https://example.com/start" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected disallowed redirect to fail.");
    }
    expect(result.errorCode).toBe("tool_execution_error");
    expect(result.errorMessage).toMatch(/not in the allowed fetch list/i);
  });

  it("returns validation error when extract backend is disabled", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(
      sandboxService,
      { fetch: () => new Response("ok", { status: 200 }) },
      createWebConfig({ extractBackend: "disabled" })
    );
    const prepared = tool.prepare({ url: "https://example.com/page" }, createContext());
    const result = await tool.execute(
      { ...prepared.preparedInput, backend: "disabled" },
      createContext()
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected disabled extract backend to fail.");
    }
    expect(result.errorCode).toBe("tool_validation_error");
    expect(result.errorMessage).toContain("disabled");
  });

  it("uses deterministic summarization when no summarizer is configured", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const longText = `# Heading\n\n${"Paragraph line. ".repeat(80)}`;
    const tool = new WebFetchTool(
      sandboxService,
      {
        fetch: () =>
          new Response(longText, {
            headers: { "content-type": "text/plain" },
            status: 200
          })
      },
      createWebConfig({
        longPageThresholdBytes: 50,
        summaryTargetBytes: 80
      })
    );

    const prepared = tool.prepare({ url: "https://example.com/long" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected deterministic summarization to succeed.");
    }
    const output = result.output as { extractionMode: string; summarized: boolean };
    expect(output.extractionMode).toBe("summarized");
    expect(output.summarized).toBe(true);
  });

  it("extracts readable text from HTML responses", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const html = `
      <html>
        <head><title>DocTitle</title><script>console.log("x")</script></head>
        <body><main>Hello <b>World</b></main></body>
      </html>
    `;
    const tool = new WebFetchTool(sandboxService, {
      fetch: () =>
        new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8"
          },
          status: 200
        })
    });

    const prepared = tool.prepare(
      {
        url: "https://example.com/doc"
      },
      createContext()
    );

    const result = await tool.execute(prepared.preparedInput, createContext());
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected html fetch to succeed.");
    }
    const output = result.output as { body: string; extractedTitle: string | null };
    expect(output.extractedTitle).toBe("DocTitle");
    expect(output.body).toContain("Hello World");
    expect(output.body).not.toContain("console.log");
  });

  it("keeps full extraction behavior when prompt is omitted", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(sandboxService, {
      fetch: () => new Response("plain body", { status: 200 })
    });

    const prepared = tool.prepare({ url: "https://example.com/no-prompt" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected no-prompt extraction to succeed.");
    }
    const output = result.output as {
      cached: boolean;
      citations: Array<{ citationId: string; citedText: string }>;
      extractionMode: string;
      summarized: boolean;
    };
    expect(output.extractionMode).toBe("full");
    expect(output.summarized).toBe(false);
    expect(output.cached).toBe(false);
    expect(output.citations[0]?.citationId).toMatch(/^extract:[a-f0-9]{12}:1$/u);
    expect(output.citations[0]?.citedText).toBe("plain body");
  });

  it("summarizes long extracted markdown and records evidence", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const longText = `<html><body><main><h1>Title</h1><p>${"Long body ".repeat(200)}</p></main></body></html>`;
    const tool = new WebFetchTool(
      sandboxService,
      {
        fetch: () =>
          new Response(longText, {
            headers: {
              "content-type": "text/html; charset=utf-8"
            },
            status: 200
          })
      },
      createWebConfig({
        longPageThresholdBytes: 100,
        summaryTargetBytes: 80
      }),
      undefined,
      {
        summarize: () => Promise.resolve("Summary line\nImportant evidence")
      }
    );

    const prepared = tool.prepare({ url: "https://example.com/long" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected long page extraction to succeed.");
    }
    const output = result.output as {
      evidence: string[];
      extractionMode: string;
      markdown: string;
      summarized: boolean;
    };
    expect(output.extractionMode).toBe("summarized");
    expect(output.summarized).toBe(true);
    expect(output.markdown).toContain("Summary line");
    expect(output.evidence).toContain("Important evidence");
  });

  it("uses provider summarizer for prompt extraction", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    let summarizerPrompt: string | undefined;
    const tool = new WebFetchTool(
      sandboxService,
      {
        fetch: () =>
          new Response("<html><head><title>Prompt Doc</title></head><body><p>Robotics release notes.</p></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
            status: 200
          })
      },
      createWebConfig(),
      undefined,
      {
        summarize: (input) => {
          summarizerPrompt = input.prompt;
          return Promise.resolve("Answer line\nEvidence line");
        }
      }
    );

    const prepared = tool.prepare(
      {
        prompt: "What does the page say about robotics?",
        url: "https://example.com/prompt-provider"
      },
      createContext()
    );
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected prompt extraction to succeed.");
    }
    const output = result.output as {
      cached: boolean;
      citations: Array<{ citationId: string; citedText: string; title: string }>;
      extractionMode: string;
      markdown: string;
      summarized: boolean;
    };
    expect(summarizerPrompt).toBe("What does the page say about robotics?");
    expect(output.extractionMode).toBe("prompt_extract");
    expect(output.summarized).toBe(true);
    expect(output.cached).toBe(false);
    expect(output.markdown).toContain("Answer line");
    expect(output.citations[0]).toMatchObject({
      citedText: "Answer line",
      title: "Prompt Doc"
    });
    expect(output.citations[0]?.citationId).toMatch(/^extract:[a-f0-9]{12}:1$/u);
  });

  it("falls back deterministically when prompt summarization fails", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(
      sandboxService,
      {
        fetch: () =>
          new Response(
            "<html><head><title>Fallback Doc</title></head><body><p>Needle fact: ROS 2 Humble is referenced.</p><p>Other paragraph.</p></body></html>",
            {
              headers: { "content-type": "text/html; charset=utf-8" },
              status: 200
            }
          )
      },
      createWebConfig(),
      undefined,
      {
        summarize: () => Promise.reject(new Error("summarizer unavailable"))
      }
    );

    const prepared = tool.prepare(
      {
        prompt: "Find the Needle fact.",
        url: "https://example.com/prompt-fallback"
      },
      createContext()
    );
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected prompt fallback extraction to succeed.");
    }
    const output = result.output as {
      citations: Array<{ citedText: string }>;
      extractionMode: string;
      markdown: string;
      summarized: boolean;
    };
    expect(output.extractionMode).toBe("prompt_extract");
    expect(output.summarized).toBe(false);
    expect(output.markdown).toContain("Needle fact");
    expect(output.citations[0]?.citedText).toContain("Title: Fallback Doc");
  });

  it("returns cached prompt extraction results on the second identical request", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    let fetchCount = 0;
    const tool = new WebFetchTool(sandboxService, {
      fetch: () => {
        fetchCount += 1;
        return new Response("<html><body><p>Cacheable prompt content.</p></body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200
        });
      }
    });
    const prepared = tool.prepare(
      {
        prompt: "Extract cacheable prompt content.",
        url: "https://example.com/prompt-cache"
      },
      createContext()
    );

    const first = await tool.execute(prepared.preparedInput, createContext());
    const second = await tool.execute(prepared.preparedInput, createContext());

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (!first.success || !second.success) {
      throw new Error("Expected cached prompt extraction to succeed.");
    }
    expect((first.output as { cached: boolean }).cached).toBe(false);
    expect((second.output as { cached: boolean }).cached).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it("falls back to truncation when long page summarization fails", async () => {
    const sandboxService = new SandboxService({
      allowedFetchHosts: ["example.com"],
      workspaceRoot: process.cwd()
    });
    const tool = new WebFetchTool(
      sandboxService,
      {
        fetch: () => new Response("x".repeat(500), { status: 200 })
      },
      createWebConfig({
        longPageThresholdBytes: 100,
        summaryTargetBytes: 60
      }),
      undefined,
      {
        summarize: () => Promise.reject(new Error("summarizer unavailable"))
      }
    );

    const prepared = tool.prepare({ url: "https://example.com/long" }, createContext());
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected fallback extraction to succeed.");
    }
    const output = result.output as { extractionMode: string; truncated: boolean };
    expect(output.extractionMode).toBe("truncated_fallback");
    expect(output.truncated).toBe(true);
  });

  it("normalizes Firecrawl provider extraction", async () => {
    let requestBody: unknown = null;
    let requestUrl = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      requestBody = parseRequestBody(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              markdown: "# Provider Doc\nBody",
              title: "Provider Doc",
              url: "https://example.com/doc"
            }
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;
    try {
      const result = await new FirecrawlWebExtractClient().extract({
        apiKey: "key",
        apiUrl: "https://api.firecrawl.dev/v1/search",
        signal: new AbortController().signal,
        url: "https://example.com/doc"
      });

      expect(requestUrl).toBe("https://api.firecrawl.dev/v1/scrape");
      expect(requestBody).toMatchObject({ formats: ["markdown"], url: "https://example.com/doc" });
      expect(result.provider).toBe("firecrawl");
      expect(result.markdown).toContain("Provider Doc");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes Tavily provider extraction", async () => {
    let requestBody: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      requestBody = parseRequestBody(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [{ content: "Tavily body", title: "Tavily Doc", url: "https://example.com/doc" }]
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;
    try {
      const result = await new TavilyWebExtractClient().extract({
        apiKey: "tavily-key",
        apiUrl: "https://api.tavily.com/extract",
        signal: new AbortController().signal,
        url: "https://example.com/doc"
      });

      expect(requestBody).toMatchObject({ api_key: "tavily-key", urls: ["https://example.com/doc"] });
      expect(result.markdown).toContain("Tavily body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes Exa provider extraction with urls", async () => {
    let requestBody: unknown = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      requestBody = parseRequestBody(init?.body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [{ text: "Exa body", title: "Exa Doc", url: "https://example.com/doc" }]
          }),
          { status: 200 }
        )
      );
    }) as typeof fetch;
    try {
      const result = await new ExaWebExtractClient().extract({
        apiKey: "exa-key",
        apiUrl: "https://api.exa.ai/search",
        signal: new AbortController().signal,
        url: "https://example.com/doc"
      });

      expect(requestBody).toMatchObject({ text: true, urls: ["https://example.com/doc"] });
      expect(result.markdown).toContain("Exa body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-web-fetch-test",
    userId: "test-user",
    workspaceRoot: process.cwd()
  };
}

function parseRequestBody(body: BodyInit | null | undefined): unknown {
  return typeof body === "string" ? JSON.parse(body) : null;
}

function createWebConfig(patch: Partial<WebRuntimeConfig> = {}): WebRuntimeConfig {
  return {
    backend: "disabled",
    extractBackend: "http",
    longPageThresholdBytes: 64_000,
    maxResults: 5,
    providers: {
      brave: { apiKey: null, apiKeyEnv: "BRAVE_SEARCH_API_KEY", apiUrl: null },
      ddgs: { apiKey: null, apiKeyEnv: null, apiUrl: null },
      exa: { apiKey: null, apiKeyEnv: "EXA_API_KEY", apiUrl: "https://api.exa.ai/contents" },
      firecrawl: { apiKey: "key", apiKeyEnv: "FIRECRAWL_API_KEY", apiUrl: "https://api.firecrawl.dev/v1/search" },
      searxng: { apiKey: null, apiKeyEnv: null, apiUrl: null },
      tavily: { apiKey: null, apiKeyEnv: "TAVILY_API_KEY", apiUrl: "https://api.tavily.com/extract" }
    },
    searchBackend: "disabled",
    summaryTargetBytes: 5_000,
    ...patch
  };
}
