import { z } from "zod";
import { parse } from "node-html-parser";
import type { HTMLElement } from "node-html-parser";

import type { WebExtractBackend, WebRuntimeConfig } from "../core/web-search-config.js";
import type { SandboxService } from "../sandbox/sandbox-service.js";
import type {
  JsonObject,
  SandboxWebPlan,
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";
import {
  authJsonHeaders,
  buildCitation,
  buildCitationId,
  byteLength,
  makeCacheKey,
  readJsonResponse,
  readString,
  requireApiKey,
  requiredUrl,
  sliceByBytes,
  type WebCitation
} from "./web-shared.js";

export interface WebFetchClient {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface WebExtractClientInput {
  apiKey: string | null;
  apiUrl: string | null;
  signal: AbortSignal;
  url: string;
}

export interface WebExtractClientOutput {
  body: string;
  contentType: string | null;
  markdown: string;
  provider: string;
  status: number;
  statusText: string;
  title: string | null;
  url: string;
}

export interface WebExtractClient {
  readonly backend: Exclude<WebExtractBackend, "disabled" | "http">;
  readonly requiresApiKey: boolean;
  extract(input: WebExtractClientInput): Promise<WebExtractClientOutput>;
}

export interface WebPageSummarizerInput {
  markdown: string;
  prompt?: string;
  signal: AbortSignal;
  targetBytes: number;
  title: string | null;
  url: string;
}

export interface WebPageSummarizer {
  summarize(input: WebPageSummarizerInput): Promise<string>;
}

interface PreparedWebFetchInput {
  backend: WebExtractBackend;
  maxBytes: number;
  maxRedirects: number;
  plan: SandboxWebPlan;
  prompt?: string;
  targetPlan: SandboxWebPlan;
}

const webFetchSchema = z.object({
  maxBytes: z.number().int().positive().max(200_000).default(32_768),
  maxRedirects: z.number().int().min(0).max(5).default(2),
  prompt: z.string().min(1).max(2_000).optional(),
  url: z.string().url()
});

const WEB_EXTRACT_CACHE_TTL_MS = 15 * 60 * 1000;

interface WebExtractCacheEntry {
  expiresAt: number;
  output: JsonObject;
  summary: string;
  uri: string;
}

const webExtractCache = new Map<string, WebExtractCacheEntry>();

const DEFAULT_WEB_CONFIG: WebRuntimeConfig = {
  backend: "disabled",
  extractBackend: "http",
  longPageThresholdBytes: 64_000,
  maxResults: 5,
  providers: {
    brave: { apiKey: null, apiKeyEnv: "BRAVE_SEARCH_API_KEY", apiUrl: null },
    ddgs: { apiKey: null, apiKeyEnv: null, apiUrl: null },
    exa: { apiKey: null, apiKeyEnv: "EXA_API_KEY", apiUrl: "https://api.exa.ai/contents" },
    firecrawl: { apiKey: null, apiKeyEnv: "FIRECRAWL_API_KEY", apiUrl: "https://api.firecrawl.dev/v1/search" },
    searxng: { apiKey: null, apiKeyEnv: null, apiUrl: null },
    tavily: { apiKey: null, apiKeyEnv: "TAVILY_API_KEY", apiUrl: "https://api.tavily.com/extract" }
  },
  searchBackend: "disabled",
  summaryTargetBytes: 5_000
};

export class WebFetchTool implements ToolDefinition<typeof webFetchSchema, PreparedWebFetchInput> {
  public readonly name = "web_extract";
  public readonly description =
    "Fetch and extract a public text-oriented HTTP resource through a sandboxed allowlist.";
  public readonly capability = "network.fetch_public_readonly" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "cheap" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = webFetchSchema;

  public constructor(
    private readonly sandboxService: SandboxService,
    private readonly client: WebFetchClient = {
      fetch: (input, init) => fetch(input, init)
    },
    private readonly config: WebRuntimeConfig = DEFAULT_WEB_CONFIG,
    private readonly extractClients: Map<Exclude<WebExtractBackend, "disabled" | "http">, WebExtractClient> =
      createDefaultExtractClients(),
    private readonly summarizer: WebPageSummarizer | null = null
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    if (this.config.extractBackend === "disabled") {
      return {
        available: false,
        reason: "web_extract backend is disabled"
      };
    }
    if (this.config.extractBackend === "http") {
      return {
        available: true,
        reason: "web_extract uses sandboxed HTTP fallback"
      };
    }
    const client = this.extractClients.get(this.config.extractBackend);
    const provider = this.config.providers[this.config.extractBackend];
    if (client === undefined || provider === undefined) {
      return {
        available: false,
        reason: `web_extract backend ${this.config.extractBackend} is not registered`
      };
    }
    if (client.requiresApiKey && provider.apiKey === null) {
      return {
        available: false,
        reason: `${provider.apiKeyEnv ?? this.config.extractBackend} is required for ${this.config.extractBackend} web_extract`
      };
    }
    if (provider.apiUrl === null) {
      return {
        available: false,
        reason: `web_extract backend ${this.config.extractBackend} requires an apiUrl`
      };
    }
    return {
      available: true,
      reason: `web_extract backend ${this.config.extractBackend} is configured`
    };
  }

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedWebFetchInput> {
    void context;
    const parsedInput = this.inputSchema.parse(input);
    const targetPlan = this.sandboxService.prepareWebFetch(parsedInput.url);
    const endpointUrl =
      this.config.extractBackend === "http" || this.config.extractBackend === "disabled"
        ? parsedInput.url
        : this.config.providers[this.config.extractBackend]?.apiUrl ?? parsedInput.url;
    const endpointPlan = this.sandboxService.prepareWebFetch(endpointUrl);
    const plan: SandboxWebPlan = {
      ...endpointPlan,
      method: this.config.extractBackend === "http" ? "GET" : "POST"
    };

    return {
      governance: {
        pathScope: targetPlan.pathScope,
        summary: `Fetch ${targetPlan.url}`
      },
      preparedInput: {
        backend: this.config.extractBackend,
        maxBytes: parsedInput.maxBytes,
        maxRedirects: parsedInput.maxRedirects,
        plan,
        ...(parsedInput.prompt !== undefined ? { prompt: parsedInput.prompt } : {}),
        targetPlan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedWebFetchInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (input.backend === "disabled") {
      return {
        errorCode: "tool_validation_error",
        errorMessage: "web_extract is unavailable because extract backend is disabled.",
        success: false
      };
    }

    const cacheKey = makeWebExtractCacheKey(input, this.config, this.summarizer !== null);
    const cacheHit = readWebExtractCache(cacheKey);
    if (cacheHit !== null && this.isCachedWebExtractResponseAllowed(cacheHit)) {
      const output = {
        ...cacheHit.output,
        cached: true
      };
      return {
        artifacts: [
          {
            artifactType: "web_response",
            content: output,
            uri: cacheHit.uri
          }
        ],
        output,
        success: true,
        summary: cacheHit.summary
      };
    }
    if (cacheHit !== null) {
      webExtractCache.delete(cacheKey);
    }

    const requestTrace: Array<{ status: number; url: string }> = [];
    let extracted: WebExtractClientOutput;
    try {
      extracted =
        input.backend === "http"
          ? await this.extractWithHttp(input, requestTrace, context.signal)
          : await this.extractWithProvider(input, context.signal);
    } catch (error) {
      if (error instanceof WebFetchNetworkError) {
        const cause = describeUnknownError(error.cause);
        const causeMessage = typeof cause.message === "string" ? cause.message : "unknown network error";
        return {
          details: {
            cause,
            redirectTrace: requestTrace,
            url: error.url
          },
          errorCode: "tool_execution_error",
          errorMessage: `Web fetch network failed for ${error.url}: ${causeMessage}`,
          success: false
        };
      }
      const message = error instanceof Error ? error.message : "Unknown web_extract provider error.";
      return {
        details: {
          provider: input.backend,
          url: input.targetPlan.url
        },
        errorCode: "tool_execution_error",
        errorMessage: message,
        success: false
      };
    }

    const processed = await this.processMarkdown(extracted, input.maxBytes, context.signal, input.prompt);
    const summary = extracted.status >= 200 && extracted.status < 300
      ? `Fetched ${extracted.url}`
      : `Fetched ${extracted.url} with HTTP ${extracted.status}`;
    const output = {
      body: processed.body,
      cached: false,
      citations: processed.citations,
      contentType: extracted.contentType,
      evidence: processed.evidence,
      extractedTitle: extracted.title,
      fetchedAt: new Date().toISOString(),
      extractionMode: processed.extractionMode,
      markdown: processed.markdown,
      ok: extracted.status >= 200 && extracted.status < 300,
      provider: extracted.provider,
      redirectTrace: requestTrace,
      status: extracted.status,
      statusText: extracted.statusText,
      summarized: processed.summarized,
      title: extracted.title,
      truncated: processed.truncated,
      url: extracted.url
    };
    writeWebExtractCache(cacheKey, output, summary, extracted.url);

    return {
      artifacts: [
        {
          artifactType: "web_response",
          content: output,
          uri: extracted.url
        }
      ],
      output,
      success: true,
      summary
    };
  }

  private async extractWithHttp(
    input: PreparedWebFetchInput,
    requestTrace: Array<{ status: number; url: string }>,
    signal: AbortSignal
  ): Promise<WebExtractClientOutput> {
    const response = await this.followRedirects(
      input.targetPlan.url,
      input.maxRedirects,
      requestTrace,
      signal
    );
    const body = await response.text();
    const normalized = normalizeWebBody(body, response.headers.get("content-type"));
    return {
      body: normalized.content,
      contentType: response.headers.get("content-type"),
      markdown: normalized.markdown,
      provider: "http",
      status: response.status,
      statusText: response.statusText,
      title: normalized.title,
      url: response.url || input.targetPlan.url
    };
  }

  private async extractWithProvider(
    input: PreparedWebFetchInput,
    signal: AbortSignal
  ): Promise<WebExtractClientOutput> {
    const backend = input.backend as Exclude<WebExtractBackend, "disabled" | "http">;
    const client = this.extractClients.get(backend);
    const provider = this.config.providers[backend];
    if (client === undefined || provider === undefined) {
      throw new Error(`web_extract backend ${backend} is unavailable.`);
    }
    if (client.requiresApiKey && provider.apiKey === null) {
      throw new Error(`${provider.apiKeyEnv ?? backend} is required for ${backend} web_extract.`);
    }
    return client.extract({
      apiKey: provider.apiKey,
      apiUrl: input.plan.url,
      signal,
      url: input.targetPlan.url
    });
  }

  private async processMarkdown(
    extracted: WebExtractClientOutput,
    maxBytes: number,
    signal: AbortSignal,
    prompt?: string
  ): Promise<{
    body: string;
    citations: WebCitation[];
    evidence: string[];
    extractionMode: "full" | "prompt_extract" | "summarized" | "truncated_fallback";
    markdown: string;
    summarized: boolean;
    truncated: boolean;
  }> {
    const originalMarkdown = extracted.markdown.trim().length > 0 ? extracted.markdown : extracted.body;
    if (prompt !== undefined) {
      return this.processPromptExtraction(extracted, originalMarkdown, prompt, maxBytes, signal);
    }

    const shouldSummarize = byteLength(originalMarkdown) > this.config.longPageThresholdBytes;
    if (shouldSummarize) {
      try {
        const summarized =
          this.summarizer === null
            ? deterministicSummarizeMarkdown(originalMarkdown, this.config.summaryTargetBytes)
            : await this.summarizer.summarize({
                markdown: originalMarkdown,
                signal,
                targetBytes: this.config.summaryTargetBytes,
                title: extracted.title,
                url: extracted.url
              });
        const markdown = sliceByBytes(summarized, maxBytes);
        const evidence = extractEvidence(markdown);
        return {
          body: markdown,
          citations: buildExtractCitations(extracted.url, extracted.title, evidence, markdown),
          evidence,
          extractionMode: "summarized",
          markdown,
          summarized: true,
          truncated: byteLength(summarized) > maxBytes
        };
      } catch {
        const markdown = sliceByBytes(
          originalMarkdown,
          Math.min(maxBytes, this.config.summaryTargetBytes)
        );
        const evidence = extractEvidence(markdown);
        return {
          body: markdown,
          citations: buildExtractCitations(extracted.url, extracted.title, evidence, markdown),
          evidence,
          extractionMode: "truncated_fallback",
          markdown,
          summarized: false,
          truncated: true
        };
      }
    }

    const markdown = sliceByBytes(originalMarkdown, maxBytes);
    const evidence = extractEvidence(markdown);
    return {
      body: markdown,
      citations: buildExtractCitations(extracted.url, extracted.title, evidence, markdown),
      evidence,
      extractionMode: "full",
      markdown,
      summarized: false,
      truncated: byteLength(originalMarkdown) > maxBytes
    };
  }

  private async processPromptExtraction(
    extracted: WebExtractClientOutput,
    originalMarkdown: string,
    prompt: string,
    maxBytes: number,
    signal: AbortSignal
  ): Promise<{
    body: string;
    citations: WebCitation[];
    evidence: string[];
    extractionMode: "prompt_extract";
    markdown: string;
    summarized: boolean;
    truncated: boolean;
  }> {
    if (this.summarizer !== null) {
      try {
        const summarized = await this.summarizer.summarize({
          markdown: sliceByBytes(originalMarkdown, this.config.longPageThresholdBytes),
          prompt,
          signal,
          targetBytes: Math.min(maxBytes, this.config.summaryTargetBytes),
          title: extracted.title,
          url: extracted.url
        });
        const markdown = sliceByBytes(summarized, maxBytes);
        const evidence = extractEvidence(markdown);
        return {
          body: markdown,
          citations: buildExtractCitations(extracted.url, extracted.title, evidence, markdown),
          evidence,
          extractionMode: "prompt_extract",
          markdown,
          summarized: true,
          truncated: byteLength(summarized) > maxBytes
        };
      } catch {
        // Fall through to deterministic prompt extraction.
      }
    }

    const markdown = deterministicPromptExtractMarkdown(
      originalMarkdown,
      prompt,
      Math.min(maxBytes, this.config.summaryTargetBytes),
      extracted.title,
      extracted.url
    );
    const evidence = extractEvidence(markdown);
    return {
      body: markdown,
      citations: buildExtractCitations(extracted.url, extracted.title, evidence, markdown),
      evidence,
      extractionMode: "prompt_extract",
      markdown,
      summarized: false,
      truncated: byteLength(originalMarkdown) > byteLength(markdown)
    };
  }

  private isCachedWebExtractResponseAllowed(entry: WebExtractCacheEntry): boolean {
    try {
      for (const url of readCachedRedirectUrls(entry.output)) {
        this.sandboxService.prepareWebFetch(url);
      }
      this.sandboxService.prepareWebFetch(entry.uri);
      return true;
    } catch {
      return false;
    }
  }

  private async followRedirects(
    initialUrl: string,
    maxRedirects: number,
    requestTrace: Array<{ status: number; url: string }>,
    signal: AbortSignal
  ): Promise<Response> {
    let currentUrl = initialUrl;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const response = await this.fetchOnce(currentUrl, signal);
      requestTrace.push({
        status: response.status,
        url: currentUrl
      });

      if (!isRedirectStatus(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (location === null || location.trim().length === 0) {
        return response;
      }
      if (redirectCount >= maxRedirects) {
        return response;
      }

      const nextUrl = new URL(location, currentUrl).toString();
      this.sandboxService.prepareWebFetch(nextUrl);
      currentUrl = nextUrl;
    }

    return this.fetchOnce(currentUrl, signal);
  }

  private async fetchOnce(url: string, signal: AbortSignal): Promise<Response> {
    try {
      return await this.client.fetch(url, {
        method: "GET",
        redirect: "manual",
        signal
      });
    } catch (error) {
      throw new WebFetchNetworkError(url, error);
    }
  }
}

export class FirecrawlWebExtractClient implements WebExtractClient {
  public readonly backend = "firecrawl" as const;
  public readonly requiresApiKey = true;

  public async extract(input: WebExtractClientInput): Promise<WebExtractClientOutput> {
    const apiKey = requireApiKey(input.apiKey, "firecrawl", "web_extract");
    const response = await fetch(deriveFirecrawlExtractUrl(requiredUrl(input.apiUrl, "web_extract")), {
      body: JSON.stringify({ formats: ["markdown"], url: input.url }),
      headers: authJsonHeaders(apiKey),
      method: "POST",
      signal: input.signal
    });
    return normalizeProviderExtract("firecrawl", input.url, await readJsonResponse(response, "Web extract"));
  }
}

export class TavilyWebExtractClient implements WebExtractClient {
  public readonly backend = "tavily" as const;
  public readonly requiresApiKey = true;

  public async extract(input: WebExtractClientInput): Promise<WebExtractClientOutput> {
    const apiKey = requireApiKey(input.apiKey, "tavily", "web_extract");
    const response = await fetch(requiredUrl(input.apiUrl, "web_extract"), {
      body: JSON.stringify({ api_key: apiKey, urls: [input.url] }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: input.signal
    });
    return normalizeProviderExtract("tavily", input.url, await readJsonResponse(response, "Web extract"));
  }
}

export class ExaWebExtractClient implements WebExtractClient {
  public readonly backend = "exa" as const;
  public readonly requiresApiKey = true;

  public async extract(input: WebExtractClientInput): Promise<WebExtractClientOutput> {
    const apiKey = requireApiKey(input.apiKey, "exa", "web_extract");
    const response = await fetch(deriveExaContentsUrl(requiredUrl(input.apiUrl, "web_extract")), {
      body: JSON.stringify({ text: true, urls: [input.url] }),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      method: "POST",
      signal: input.signal
    });
    return normalizeProviderExtract("exa", input.url, await readJsonResponse(response, "Web extract"));
  }
}

export function createDefaultExtractClients(): Map<Exclude<WebExtractBackend, "disabled" | "http">, WebExtractClient> {
  return new Map<Exclude<WebExtractBackend, "disabled" | "http">, WebExtractClient>([
    ["exa", new ExaWebExtractClient()],
    ["firecrawl", new FirecrawlWebExtractClient()],
    ["tavily", new TavilyWebExtractClient()]
  ]);
}

function makeWebExtractCacheKey(
  input: PreparedWebFetchInput,
  config: WebRuntimeConfig,
  usesProviderSummarizer: boolean
): string {
  return makeCacheKey([
    input.backend,
    input.targetPlan.url,
    input.prompt,
    input.maxBytes,
    config.summaryTargetBytes,
    config.longPageThresholdBytes,
    usesProviderSummarizer
  ]);
}

function readWebExtractCache(cacheKey: string): WebExtractCacheEntry | null {
  const entry = webExtractCache.get(cacheKey);
  if (entry === undefined) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    webExtractCache.delete(cacheKey);
    return null;
  }
  return entry;
}

function writeWebExtractCache(cacheKey: string, output: JsonObject, summary: string, uri: string): void {
  webExtractCache.set(cacheKey, {
    expiresAt: Date.now() + WEB_EXTRACT_CACHE_TTL_MS,
    output,
    summary,
    uri
  });
}

function readCachedRedirectUrls(output: JsonObject): string[] {
  const redirectTrace = output.redirectTrace;
  if (!Array.isArray(redirectTrace)) {
    return [];
  }
  return redirectTrace.flatMap((item) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const url = (item as Record<string, unknown>).url;
      return typeof url === "string" ? [url] : [];
    }
    return [];
  });
}

class WebFetchNetworkError extends Error {
  public override readonly cause: unknown;

  public constructor(
    public readonly url: string,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WebFetchNetworkError";
    this.cause = cause;
  }
}

function normalizeProviderExtract(
  provider: string,
  requestedUrl: string,
  payload: JsonObject
): WebExtractClientOutput {
  const source =
    readObject(payload.data) ??
    readObject(payload.result) ??
    readFirstObject(payload.results) ??
    readFirstObject(payload.items) ??
    payload;
  const markdown =
    readString(source.markdown) ??
    readString(source.raw_content) ??
    readString(source.content) ??
    readString(source.text) ??
    "";
  const title = readString(source.title);
  return {
    body: markdown,
    contentType: "text/markdown",
    markdown,
    provider,
    status: 200,
    statusText: "OK",
    title,
    url: readString(source.url) ?? requestedUrl
  };
}

function deriveFirecrawlExtractUrl(url: string): string {
  return url.replace(/\/search\/?$/u, "/scrape");
}

function deriveExaContentsUrl(url: string): string {
  return url.replace(/\/search\/?$/u, "/contents");
}

function normalizeWebBody(
  body: string,
  contentType: string | null
): {
  content: string;
  markdown: string;
  title: string | null;
} {
  if (contentType?.toLowerCase().includes("text/html") !== true) {
    return {
      content: body,
      markdown: body,
      title: null
    };
  }

  const root = parse(body);
  root.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
  const title = root.querySelector("title")?.text.trim() ?? null;
  const markdown = htmlToMarkdown(root).replace(/\n{3,}/gu, "\n\n").trim();
  return {
    content: markdown.replace(/\s+/gu, " ").trim(),
    markdown,
    title
  };
}

function htmlToMarkdown(root: HTMLElement): string {
  return root.childNodes.map((node) => nodeToMarkdown(node)).join("").trim();
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function nodeToMarkdown(node: { nodeType: number; rawText?: string; childNodes?: unknown[]; tagName?: string }): string {
  if (node.nodeType === TEXT_NODE) {
    return node.rawText ?? "";
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return "";
  }
  const element = node as HTMLElement;
  const content = element.childNodes.map((child) => nodeToMarkdown(child as Parameters<typeof nodeToMarkdown>[0])).join("").trim();
  const tagName = element.tagName.toLowerCase();
  if (tagName === "title" || tagName === "head") {
    return "";
  }
  if (/^h[1-6]$/u.test(tagName)) {
    return `\n\n${"#".repeat(Number(tagName.slice(1)))} ${content}\n\n`;
  }
  if (tagName === "p" || tagName === "div" || tagName === "section" || tagName === "article" || tagName === "main") {
    return `\n\n${content}\n\n`;
  }
  if (tagName === "br") {
    return "\n";
  }
  if (tagName === "li") {
    return `\n- ${content}`;
  }
  if (tagName === "a") {
    const href = element.getAttribute("href");
    return href === undefined || href === null || href.trim().length === 0 ? content : `[${content}](${href})`;
  }
  if (tagName === "pre" || tagName === "code") {
    return `\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
  }
  return content;
}

function describeUnknownError(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      ...readErrorCode(error),
      ...readErrorCause(error.cause)
    };
  }
  return {
    message: String(error),
    name: typeof error
  };
}

function readErrorCode(error: Error): JsonObject {
  const candidate = error as { code?: unknown };
  return typeof candidate.code === "string" ? { code: candidate.code } : {};
}

function readErrorCause(cause: unknown): JsonObject {
  if (!(cause instanceof Error)) {
    return {};
  }
  return {
    causeMessage: cause.message,
    causeName: cause.name,
    ...readErrorCode(cause)
  };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function extractEvidence(markdown: string): string[] {
  return markdown
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 3);
}

function buildExtractCitations(
  url: string,
  title: string | null,
  evidence: string[],
  body: string
): WebCitation[] {
  const citationTitle = title ?? url;
  const baseId = buildCitationId("extract", url);
  const sourceLines = (evidence.length > 0 ? evidence : [body]).filter((line) => line.trim().length > 0);
  return sourceLines.slice(0, 3).map((line, index) =>
    buildCitation({
      id: `${baseId}:${index + 1}`,
      source: null,
      text: line,
      title: citationTitle,
      url
    })
  );
}

function deterministicSummarizeMarkdown(markdown: string, targetBytes: number): string {
  const lines = markdown
    .split(/\n+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const headings = lines.filter((line) => line.startsWith("#")).slice(0, 5);
  const paragraphs = lines.filter((line) => !line.startsWith("#")).slice(0, 12);
  const summary = [...headings, ...paragraphs].join("\n\n");
  return sliceByBytes(summary, targetBytes);
}

function deterministicPromptExtractMarkdown(
  markdown: string,
  prompt: string,
  targetBytes: number,
  title: string | null,
  url: string
): string {
  const blocks = markdown
    .split(/\n{2,}/u)
    .map((block) => block.replace(/\s+/gu, " ").trim())
    .filter((block) => block.length > 0);
  const promptTerms = extractPromptTerms(prompt);
  const relevantBlocks = blocks.filter((block) => {
    const normalized = block.toLowerCase();
    return promptTerms.some((term) => normalized.includes(term));
  });
  const fallbackBlocks = blocks.filter((block) => !block.startsWith("#"));
  const selectedBlocks = (relevantBlocks.length > 0 ? relevantBlocks : fallbackBlocks).slice(0, 8);
  const header = `Title: ${title ?? url}`;
  const body = selectedBlocks.length > 0
    ? selectedBlocks.join("\n\n")
    : "No extractable page text was available.";
  return sliceByBytes([header, body].join("\n\n"), targetBytes);
}

function extractPromptTerms(prompt: string): string[] {
  const terms = Array.from(
    new Set(
      prompt
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3)
    )
  );
  return terms.length > 0 ? terms : [prompt.toLowerCase().trim()].filter((term) => term.length > 0);
}

function readObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function readFirstObject(value: unknown): JsonObject | null {
  return Array.isArray(value) ? readObject(value[0]) : null;
}
