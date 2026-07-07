import { z } from "zod";
import { parse } from "node-html-parser";

import {
  buildWebSearchRemediationHint,
  listConfiguredApiSearchBackends,
  type WebRuntimeConfig,
  type WebSearchBackend,
  type WebSearchRuntimeConfig
} from "../core/web-search-config.js";
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
  braveFreshnessFromRecencyDays,
  readJsonResponse,
  readString,
  requireApiKey,
  requiredUrl,
  type WebCitation
} from "./web-shared.js";

const DEFAULT_DDGS_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/";
const DDGS_VQD_URL = "https://duckduckgo.com/";
const DDGS_LINKS_URL = "https://links.duckduckgo.com/d.js";
const BING_SEARCH_URL = "https://www.bing.com/search";
const BUILTIN_SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface WebSearchResult {
  citation?: WebCitation;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
  source?: string | null;
}

export interface WebSearchAttempt extends JsonObject {
  message?: string;
  resultCount?: number;
  status: "empty" | "failed" | "succeeded";
  statusCode?: number;
  step: string;
  url: string;
}

export interface WebSearchResponse {
  attempts?: WebSearchAttempt[];
  provider: string;
  query: string;
  results: WebSearchResult[];
}

export interface WebSearchClientInput {
  allowedDomains?: string[];
  apiKey: string | null;
  apiUrl: string | null;
  blockedDomains?: string[];
  domains?: string[];
  maxResults: number;
  query: string;
  recencyDays?: number;
  signal: AbortSignal;
}

export interface WebSearchClient {
  readonly backend: WebSearchBackend;
  readonly requiresApiKey: boolean;
  search(input: WebSearchClientInput): Promise<WebSearchResponse>;
}

interface PreparedWebSearchInput {
  allowedDomains?: string[];
  blockedDomains?: string[];
  backend: WebSearchBackend;
  maxResults: number;
  plan: SandboxWebPlan;
  query: string;
  recencyDays?: number;
}

const webSearchSchema = z
  .object({
    allowedDomains: z.array(z.string().min(1)).max(20).optional(),
    blockedDomains: z.array(z.string().min(1)).max(20).optional(),
    domains: z.array(z.string().min(1)).max(20).optional(),
    limit: z.number().int().positive().max(50).optional(),
    maxResults: z.number().int().positive().max(50).optional(),
    query: z.string().min(1),
    recencyDays: z.number().int().positive().max(365).optional()
  })
  .superRefine((value, context) => {
    const allowedDomains = value.allowedDomains ?? value.domains;
    if (allowedDomains !== undefined && value.blockedDomains !== undefined) {
      context.addIssue({
        code: "custom",
        message: "allowedDomains/domains and blockedDomains are mutually exclusive.",
        path: ["blockedDomains"]
      });
    }
  });

export class WebSearchTool implements ToolDefinition<typeof webSearchSchema, PreparedWebSearchInput> {
  public readonly name = "web_search";
  public readonly description =
    "Search the public web and return normalized search results for follow-up web_extract reads.";
  public readonly capability = "network.fetch_public_readonly" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "cheap" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = webSearchSchema;

  public constructor(
    private readonly sandboxService: SandboxService,
    config: WebRuntimeConfig | WebSearchRuntimeConfig,
    clients: Map<WebSearchBackend, WebSearchClient> | WebSearchClient = createDefaultSearchClients()
  ) {
    this.config = normalizeWebSearchToolConfig(config);
    if (clients instanceof Map) {
      this.clients = clients;
    } else {
      const backend = clients.backend ?? "firecrawl";
      this.clients = new Map([[backend, clients]]);
    }
  }

  private readonly config: WebRuntimeConfig;
  private readonly clients: Map<WebSearchBackend, WebSearchClient>;

  public checkAvailability(): ToolAvailabilityResult {
    if (this.config.searchBackend === "disabled") {
      return {
        available: false,
        reason: "web_search backend is disabled"
      };
    }
    const client = this.clients.get(this.config.searchBackend);
    if (client === undefined) {
      return {
        available: false,
        reason: `web_search backend ${this.config.searchBackend} is not registered`
      };
    }
    const provider = this.config.providers[this.config.searchBackend];
    if (client.requiresApiKey && provider.apiKey === null) {
      return {
        available: false,
        reason: `${provider.apiKeyEnv ?? this.config.searchBackend} is required for ${this.config.searchBackend} web_search`
      };
    }
    if (this.config.searchBackend !== "ddgs" && provider.apiUrl === null) {
      return {
        available: false,
        reason: `web_search backend ${this.config.searchBackend} requires an apiUrl`
      };
    }
    return {
      available: true,
      reason: `web_search backend ${this.config.searchBackend} is configured`
    };
  }

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedWebSearchInput> {
    void context;
    const parsedInput = this.inputSchema.parse(input);
    const searchBackend = this.config.searchBackend;
    const provider =
      searchBackend === "disabled" ? undefined : this.config.providers[searchBackend];
    const isExternalDdgsGateway =
      searchBackend === "ddgs" &&
      provider?.apiUrl !== null &&
      provider?.apiUrl !== undefined &&
      !isDdgsBuiltinUrl(provider.apiUrl);
    const endpointUrl =
      searchBackend === "disabled"
        ? "https://example.invalid/search"
        : searchBackend === "ddgs"
          ? provider?.apiUrl !== null && provider?.apiUrl !== undefined && isExternalDdgsGateway
            ? provider.apiUrl
            : BING_SEARCH_URL
          : provider?.apiUrl ?? "https://example.invalid/search";
    const endpointPlan = this.sandboxService.prepareWebFetch(endpointUrl);
    const usesGetMethod =
      searchBackend === "brave" ||
      searchBackend === "searxng" ||
      isExternalDdgsGateway ||
      (searchBackend === "ddgs" && !isExternalDdgsGateway);
    const plan: SandboxWebPlan = {
      ...endpointPlan,
      method: usesGetMethod ? "GET" : "POST"
    };
    const requestedLimit = parsedInput.limit ?? parsedInput.maxResults ?? 5;
    const allowedDomains = parsedInput.allowedDomains ?? parsedInput.domains;

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Search web for ${parsedInput.query}`
      },
      preparedInput: {
        ...(allowedDomains !== undefined ? { allowedDomains } : {}),
        ...(parsedInput.blockedDomains !== undefined ? { blockedDomains: parsedInput.blockedDomains } : {}),
        backend: this.config.searchBackend,
        maxResults: Math.min(requestedLimit, this.config.maxResults),
        plan,
        query: parsedInput.query,
        ...(parsedInput.recencyDays !== undefined ? { recencyDays: parsedInput.recencyDays } : {})
      },
      sandbox: plan
    };
  }

  public async execute(input: PreparedWebSearchInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (input.backend === "disabled") {
      return {
        errorCode: "tool_validation_error",
        errorMessage: "web_search is unavailable because no backend is configured.",
        success: false
      };
    }
    const client = this.clients.get(input.backend);
    const provider = this.config.providers[input.backend];
    if (client === undefined || provider === undefined) {
      return {
        errorCode: "tool_validation_error",
        errorMessage: `web_search backend ${input.backend} is unavailable.`,
        success: false
      };
    }
    if (client.requiresApiKey && provider.apiKey === null) {
      return {
        errorCode: "tool_validation_error",
        errorMessage: `${provider.apiKeyEnv ?? input.backend} is required for ${input.backend} web_search.`,
        success: false
      };
    }

    const searchInput = {
      ...(input.allowedDomains !== undefined ? { allowedDomains: input.allowedDomains } : {}),
      apiKey: provider.apiKey,
      apiUrl: provider.apiUrl,
      ...(input.blockedDomains !== undefined ? { blockedDomains: input.blockedDomains } : {}),
      maxResults: input.maxResults,
      query: input.query,
      ...(input.recencyDays !== undefined ? { recencyDays: input.recencyDays } : {}),
      signal: context.signal
    };

    try {
      const output = addSearchCitations(await client.search(searchInput));
      return buildWebSearchSuccessResult(input, output);
    } catch (error) {
      if (input.backend !== "ddgs") {
        return buildWebSearchFailureResult(input, error, input.backend);
      }

      let attempts = readWebSearchAttempts(error);
      let lastMessage = error instanceof Error ? error.message : "Unknown web_search provider error.";
      for (const fallbackBackend of listConfiguredApiSearchBackends(this.config)) {
        const fallbackClient = this.clients.get(fallbackBackend);
        const fallbackProvider = this.config.providers[fallbackBackend];
        if (fallbackClient === undefined) {
          continue;
        }
        try {
          const output = addSearchCitations(
            await fallbackClient.search({
              ...searchInput,
              apiKey: fallbackProvider.apiKey,
              apiUrl: fallbackProvider.apiUrl
            })
          );
          if (output.results.length > 0) {
            return buildWebSearchSuccessResult(input, output, {
              fallbackFrom: "ddgs",
              requestedBackend: "ddgs"
            });
          }
        } catch (fallbackError) {
          lastMessage =
            fallbackError instanceof Error ? fallbackError.message : "Unknown web_search provider error.";
          attempts = [...attempts, ...readWebSearchAttempts(fallbackError)];
        }
      }

      return buildWebSearchFailureResult(input, lastMessage, "ddgs", attempts);
    }
  }
}

export class FirecrawlWebSearchClient implements WebSearchClient {
  public readonly backend = "firecrawl" as const;
  public readonly requiresApiKey = true;

  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const response = await fetch(requiredUrl(input.apiUrl, "web_search"), {
      body: JSON.stringify({
        ...buildFirecrawlFilter(input),
        limit: input.maxResults,
        query: input.query,
        ...(input.recencyDays !== undefined ? { tbs: `qdr:d${input.recencyDays}` } : {})
      }),
      headers: authJsonHeaders(requireApiKey(input.apiKey, "firecrawl", "web_search")),
      method: "POST",
      signal: input.signal
    });
    return normalizeSearchResponse("firecrawl", input, await readJsonResponse(response, "Web search"), [
      "data",
      "results",
      "items"
    ]);
  }
}

export class TavilyWebSearchClient implements WebSearchClient {
  public readonly backend = "tavily" as const;
  public readonly requiresApiKey = true;

  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const apiKey = requireApiKey(input.apiKey, "tavily", "web_search");
    const response = await fetch(requiredUrl(input.apiUrl, "web_search"), {
      body: JSON.stringify({
        api_key: apiKey,
        ...(input.allowedDomains !== undefined ? { include_domains: input.allowedDomains } : {}),
        ...(input.blockedDomains !== undefined ? { exclude_domains: input.blockedDomains } : {}),
        ...(input.recencyDays !== undefined ? { days: input.recencyDays } : {}),
        max_results: input.maxResults,
        query: input.query,
        search_depth: "basic"
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: input.signal
    });
    return normalizeSearchResponse("tavily", input, await readJsonResponse(response, "Web search"), ["results"]);
  }
}

export class ExaWebSearchClient implements WebSearchClient {
  public readonly backend = "exa" as const;
  public readonly requiresApiKey = true;

  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const apiKey = requireApiKey(input.apiKey, "exa", "web_search");
    const response = await fetch(requiredUrl(input.apiUrl, "web_search"), {
      body: JSON.stringify({
        ...(input.allowedDomains !== undefined ? { includeDomains: input.allowedDomains } : {}),
        ...(input.blockedDomains !== undefined ? { excludeDomains: input.blockedDomains } : {}),
        numResults: input.maxResults,
        query: input.query
      }),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey
      },
      method: "POST",
      signal: input.signal
    });
    return normalizeSearchResponse("exa", input, await readJsonResponse(response, "Web search"), ["results"]);
  }
}

export class BraveWebSearchClient implements WebSearchClient {
  public readonly backend = "brave" as const;
  public readonly requiresApiKey = true;

  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const apiKey = requireApiKey(input.apiKey, "brave", "web_search");
    const url = new URL(requiredUrl(input.apiUrl, "web_search"));
    url.searchParams.set("q", input.query);
    url.searchParams.set("count", String(input.maxResults));
    if (input.recencyDays !== undefined) {
      url.searchParams.set("freshness", braveFreshnessFromRecencyDays(input.recencyDays));
    }
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey
      },
      method: "GET",
      signal: input.signal
    });
    return normalizeSearchResponse("brave", input, await readJsonResponse(response, "Web search"), [
      "web.results",
      "results"
    ]);
  }
}

export class SearxngWebSearchClient implements WebSearchClient {
  public readonly backend = "searxng" as const;
  public readonly requiresApiKey = false;

  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const url = new URL(requiredUrl(input.apiUrl, "web_search"));
    url.searchParams.set("q", input.query);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(input.maxResults));
    const response = await fetch(url, {
      method: "GET",
      signal: input.signal
    });
    return normalizeSearchResponse("searxng", input, await readJsonResponse(response, "Web search"), ["results"]);
  }
}

export class DdgsWebSearchClient implements WebSearchClient {
  public readonly backend = "ddgs" as const;
  public readonly requiresApiKey = false;

  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    if (input.apiUrl !== null && !isDdgsBuiltinUrl(input.apiUrl)) {
      const url = new URL(input.apiUrl);
      url.searchParams.set("q", input.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("limit", String(input.maxResults));
      const response = await fetch(url, {
        method: "GET",
        signal: input.signal
      });
      return normalizeSearchResponse("ddgs", input, await readJsonResponse(response, "Web search"), ["results", "data"]);
    }
    return this.searchBuiltIn(input);
  }

  private async searchBuiltIn(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const attempts: WebSearchAttempt[] = [];
    const ddgs = await this.tryDdgsSearch(input, attempts);
    if (ddgs !== null && ddgs.results.length > 0) {
      return { ...ddgs, attempts };
    }
    let bing: WebSearchResponse;
    try {
      bing = await this.searchViaBing(input, attempts);
    } catch (error) {
      throw new WebSearchProviderError(
        "Built-in web search failed (DuckDuckGo unavailable and Bing failed). " +
          "Configure an alternative: set BRAVE_SEARCH_API_KEY (free tier), SEARXNG_URL, or DDGS_URL for a ddgs-proxy gateway.",
        attempts,
        error
      );
    }
    if (bing.results.length > 0) {
      return { ...bing, attempts };
    }
    throw new WebSearchProviderError(
      "Built-in web search failed (DuckDuckGo blocked and Bing returned no results). " +
      "Configure an alternative: set BRAVE_SEARCH_API_KEY (free tier), SEARXNG_URL, or DDGS_URL for a ddgs-proxy gateway.",
      attempts
    );
  }

  private async tryDdgsSearch(
    input: WebSearchClientInput,
    attempts: WebSearchAttempt[]
  ): Promise<WebSearchResponse | null> {
    try {
      const vqd = await this.acquireVqdToken(input.query, input.signal, attempts);
      const links = await this.queryViaLinksApi(input, vqd, attempts);
      if (links !== null && links.results.length > 0) {
        return links;
      }
    } catch {
      // DuckDuckGo unavailable; fall through to Bing.
    }
    try {
      return await this.searchViaDdgsHtml(input, attempts);
    } catch {
      return null;
    }
  }

  private async acquireVqdToken(
    query: string,
    signal: AbortSignal,
    attempts: WebSearchAttempt[]
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch(DDGS_VQD_URL, {
        body: new URLSearchParams({ q: query }).toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": DDGS_VQD_URL,
          "User-Agent": BUILTIN_SEARCH_USER_AGENT
        },
        method: "POST",
        signal
      });
    } catch (error) {
      attempts.push({
        message: describeSearchError(error),
        status: "failed",
        step: "ddg_vqd",
        url: DDGS_VQD_URL
      });
      throw error;
    }
    const headerVqd = response.headers.get("x-vqd-4");
    if (headerVqd !== null && headerVqd.trim().length > 0) {
      await response.text();
      attempts.push({
        status: "succeeded",
        statusCode: response.status,
        step: "ddg_vqd",
        url: DDGS_VQD_URL
      });
      return headerVqd.trim();
    }
    const html = await response.text();
    const match = html.match(/vqd=["']([^"']+)["']/);
    if (match?.[1] !== undefined) {
      attempts.push({
        status: "succeeded",
        statusCode: response.status,
        step: "ddg_vqd",
        url: DDGS_VQD_URL
      });
      return match[1];
    }
    attempts.push({
      message: "DuckDuckGo did not return a search token.",
      status: "failed",
      statusCode: response.status,
      step: "ddg_vqd",
      url: DDGS_VQD_URL
    });
    throw new Error("DuckDuckGo did not return a search token.");
  }

  private async queryViaLinksApi(
    input: WebSearchClientInput,
    vqd: string,
    attempts: WebSearchAttempt[]
  ): Promise<WebSearchResponse | null> {
    const url = new URL(DDGS_LINKS_URL);
    url.searchParams.set("q", input.query);
    url.searchParams.set("vqd", vqd);
    url.searchParams.set("kl", "wt-wt");
    url.searchParams.set("l", "wt-wt");
    url.searchParams.set("p", "");
    url.searchParams.set("s", "0");
    url.searchParams.set("df", "");
    url.searchParams.set("ex", "-1");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "Referer": DDGS_VQD_URL,
          "User-Agent": BUILTIN_SEARCH_USER_AGENT
        },
        signal: input.signal
      });
    } catch (error) {
      attempts.push({
        message: describeSearchError(error),
        status: "failed",
        step: "ddg_links",
        url: url.toString()
      });
      throw error;
    }
    const text = await response.text();
    const jsonMatch = text.match(/DDG\.pageLayout\.load\('d',(\[[\s\S]*\])\);/);
    if (jsonMatch === null) {
      attempts.push({
        message: "DuckDuckGo links API did not return a result payload.",
        status: "empty",
        statusCode: response.status,
        step: "ddg_links",
        url: url.toString()
      });
      return null;
    }
    try {
      const raw = JSON.parse(jsonMatch[1] as string) as Array<Record<string, unknown>>;
      const allowedDomains = input.allowedDomains ?? input.domains;
      const results: WebSearchResult[] = [];
      for (const item of raw) {
        if (typeof item.u !== "string" || typeof item.t !== "string") {
          continue;
        }
        const title = String(item.t).replace(/<\/?b>/g, "");
        const snippet = typeof item.a === "string" ? String(item.a).replace(/<\/?b>/g, "") : "";
        if (!isAllowedByDomainFilters(item.u, allowedDomains, input.blockedDomains)) {
          continue;
        }
        results.push({ snippet, title, url: item.u });
        if (results.length >= input.maxResults) {
          break;
        }
      }
      attempts.push({
        resultCount: results.length,
        status: results.length > 0 ? "succeeded" : "empty",
        statusCode: response.status,
        step: "ddg_links",
        url: url.toString()
      });
      return { provider: "ddgs", query: input.query, results };
    } catch (error) {
      attempts.push({
        message: describeSearchError(error),
        status: "failed",
        statusCode: response.status,
        step: "ddg_links",
        url: url.toString()
      });
      return null;
    }
  }

  private async searchViaDdgsHtml(
    input: WebSearchClientInput,
    attempts: WebSearchAttempt[]
  ): Promise<WebSearchResponse | null> {
    let response: Response;
    try {
      response = await fetch(DEFAULT_DDGS_HTML_SEARCH_URL, {
        body: new URLSearchParams({ q: input.query }).toString(),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": DEFAULT_DDGS_HTML_SEARCH_URL,
          "User-Agent": BUILTIN_SEARCH_USER_AGENT
        },
        method: "POST",
        signal: input.signal
      });
    } catch (error) {
      attempts.push({
        message: describeSearchError(error),
        status: "failed",
        step: "ddg_html",
        url: DEFAULT_DDGS_HTML_SEARCH_URL
      });
      throw error;
    }
    const html = await response.text();
    if (
      !response.ok ||
      html.includes("anomaly-modal") ||
      html.includes("challenge-form")
    ) {
      attempts.push({
        message: response.ok ? "DuckDuckGo HTML search returned a challenge page." : `HTTP ${response.status}`,
        status: "failed",
        statusCode: response.status,
        step: "ddg_html",
        url: DEFAULT_DDGS_HTML_SEARCH_URL
      });
      return null;
    }
    const allowedDomains = input.allowedDomains ?? input.domains;
    const results = parseDuckDuckGoHtmlResults(html)
      .filter((item) => isAllowedByDomainFilters(item.url, allowedDomains, input.blockedDomains))
      .slice(0, input.maxResults);
    if (results.length === 0) {
      attempts.push({
        resultCount: 0,
        status: "empty",
        statusCode: response.status,
        step: "ddg_html",
        url: DEFAULT_DDGS_HTML_SEARCH_URL
      });
      return null;
    }
    attempts.push({
      resultCount: results.length,
      status: "succeeded",
      statusCode: response.status,
      step: "ddg_html",
      url: DEFAULT_DDGS_HTML_SEARCH_URL
    });
    return {
      provider: "ddgs",
      query: input.query,
      results
    };
  }

  private async searchViaBing(
    input: WebSearchClientInput,
    attempts: WebSearchAttempt[]
  ): Promise<WebSearchResponse> {
    const url = new URL(BING_SEARCH_URL);
    url.searchParams.set("q", input.query);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "User-Agent": BUILTIN_SEARCH_USER_AGENT
        },
        redirect: "follow",
        signal: input.signal
      });
    } catch (error) {
      attempts.push({
        message: describeSearchError(error),
        status: "failed",
        step: "bing",
        url: url.toString()
      });
      throw error;
    }
    const html = await response.text();
    if (!response.ok) {
      attempts.push({
        message: `HTTP ${response.status}`,
        status: "failed",
        statusCode: response.status,
        step: "bing",
        url: url.toString()
      });
      throw new Error(`Bing web search failed with HTTP status ${response.status}.`);
    }
    const allowedDomains = input.allowedDomains ?? input.domains;
    const results = parseBingHtmlResults(html)
      .filter((item) => isAllowedByDomainFilters(item.url, allowedDomains, input.blockedDomains))
      .slice(0, input.maxResults);
    attempts.push({
      resultCount: results.length,
      status: results.length > 0 ? "succeeded" : "empty",
      statusCode: response.status,
      step: "bing",
      url: url.toString()
    });
    return {
      provider: "bing",
      query: input.query,
      results
    };
  }
}

export function createDefaultSearchClients(): Map<WebSearchBackend, WebSearchClient> {
  return new Map<WebSearchBackend, WebSearchClient>([
    ["brave", new BraveWebSearchClient()],
    ["ddgs", new DdgsWebSearchClient()],
    ["exa", new ExaWebSearchClient()],
    ["firecrawl", new FirecrawlWebSearchClient()],
    ["searxng", new SearxngWebSearchClient()],
    ["tavily", new TavilyWebSearchClient()]
  ]);
}

class WebSearchProviderError extends Error {
  public override readonly cause: unknown;

  public constructor(
    message: string,
    public readonly attempts: WebSearchAttempt[],
    cause: unknown = null
  ) {
    super(message);
    this.name = "WebSearchProviderError";
    this.cause = cause;
  }
}

function buildWebSearchSuccessResult(
  input: PreparedWebSearchInput,
  output: WebSearchResponse,
  details: JsonObject = {}
): ToolExecutionResult {
  return {
    artifacts: [
      {
        artifactType: "web_search_results",
        content: output as unknown as JsonObject,
        uri: input.plan.url
      }
    ],
    details,
    output: output as unknown as JsonObject,
    success: true,
    summary: `Found ${output.results.length} web results for ${input.query}`
  };
}

function buildWebSearchFailureResult(
  input: PreparedWebSearchInput,
  error: unknown,
  provider: WebSearchBackend,
  attempts: WebSearchAttempt[] = readWebSearchAttempts(error)
): ToolExecutionResult {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "Unknown web_search provider error.";
  return {
    details: {
      attempts,
      endpointUrl: input.plan.url,
      provider,
      remediation: buildWebSearchRemediationHint(),
      url: input.plan.url
    },
    errorCode: "tool_execution_error",
    errorMessage: message,
    success: false
  };
}

function addSearchCitations(response: WebSearchResponse): WebSearchResponse {
  return {
    ...response,
    results: response.results.map((result, index) => ({
      ...result,
      citation: result.citation ?? buildCitation({
        id: buildCitationId("search", index + 1),
        source: result.source ?? response.provider,
        text: result.snippet.length > 0 ? result.snippet : result.title,
        title: result.title,
        url: result.url
      })
    }))
  };
}

function readWebSearchAttempts(error: unknown): WebSearchAttempt[] {
  if (error instanceof WebSearchProviderError) {
    return error.attempts;
  }
  if (error === null || typeof error !== "object") {
    return [];
  }
  const candidate = (error as { attempts?: unknown }).attempts;
  return Array.isArray(candidate) ? candidate.filter(isWebSearchAttempt) : [];
}

function isWebSearchAttempt(value: unknown): value is WebSearchAttempt {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.step === "string" &&
    typeof record.url === "string" &&
    (record.status === "empty" || record.status === "failed" || record.status === "succeeded")
  );
}

function describeSearchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWebSearchToolConfig(config: WebRuntimeConfig | WebSearchRuntimeConfig): WebRuntimeConfig {
  if ("searchBackend" in config && "providers" in config) {
    return config;
  }
  return {
    backend: config.backend,
    extractBackend: "http",
    longPageThresholdBytes: 64_000,
    maxResults: config.maxResults,
    providers: {
      brave: { apiKey: null, apiKeyEnv: "BRAVE_SEARCH_API_KEY", apiUrl: null },
      ddgs: { apiKey: null, apiKeyEnv: null, apiUrl: null },
      exa: { apiKey: null, apiKeyEnv: "EXA_API_KEY", apiUrl: null },
      firecrawl: {
        apiKey: config.apiKey,
        apiKeyEnv: config.apiKeyEnv,
        apiUrl: config.apiUrl
      },
      searxng: { apiKey: null, apiKeyEnv: null, apiUrl: null },
      tavily: { apiKey: null, apiKeyEnv: "TAVILY_API_KEY", apiUrl: null }
    },
    searchBackend: config.backend,
    summaryTargetBytes: 5_000
  };
}

function buildFirecrawlFilter(input: WebSearchClientInput): Record<string, unknown> {
  const allowedDomains = input.allowedDomains ?? input.domains;
  const filter: Record<string, string[]> = {};
  if (allowedDomains !== undefined) {
    filter.domains = allowedDomains;
  }
  if (input.blockedDomains !== undefined) {
    filter.excludeDomains = input.blockedDomains;
  }
  return Object.keys(filter).length > 0 ? { filter } : {};
}

function normalizeSearchResponse(
  provider: string,
  input: WebSearchClientInput,
  payload: JsonObject,
  resultPaths: string[]
): WebSearchResponse {
  const allowedDomains = input.allowedDomains ?? input.domains;
  const sourceResults = resultPaths
    .map((path) => readPath(payload, path))
    .find(Array.isArray) as unknown[] | undefined;
  const results = (sourceResults ?? [])
    .flatMap((item) => normalizeSearchItem(item))
    .filter((item) => isAllowedByDomainFilters(item.url, allowedDomains, input.blockedDomains))
    .slice(0, input.maxResults);
  return {
    provider,
    query: input.query,
    results
  };
}

function readPath(value: JsonObject, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

function normalizeSearchItem(item: unknown): WebSearchResult[] {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    return [];
  }
  const record = item as Record<string, unknown>;
  const url = readString(record.url) ?? readString(record.link);
  if (url === null) {
    return [];
  }
  const title = readString(record.title) ?? url;
  const snippet =
    readString(record.snippet) ??
    readString(record.description) ??
    readString(record.content) ??
    readString(record.markdown) ??
    readString(record.text) ??
    "";
  const publishedAt =
    readString(record.publishedAt) ??
    readString(record.publishedDate) ??
    readString(record.published_date) ??
    readString(record.date);
  return [
    {
      ...(publishedAt !== null ? { publishedAt } : {}),
      ...(readString(record.source) !== null ? { source: readString(record.source) } : {}),
      snippet,
      title,
      url
    }
  ];
}

function isAllowedByDomainFilters(
  rawUrl: string,
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined
): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (allowedDomains !== undefined && !allowedDomains.some((domain) => domainMatches(hostname, domain))) {
    return false;
  }
  if (blockedDomains !== undefined && blockedDomains.some((domain) => domainMatches(hostname, domain))) {
    return false;
  }
  return true;
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function isDdgsBuiltinUrl(apiUrl: string): boolean {
  try {
    const hostname = new URL(apiUrl).hostname.toLowerCase();
    return hostname === "html.duckduckgo.com" ||
      hostname === "duckduckgo.com" ||
      hostname === "links.duckduckgo.com";
  } catch {
    return false;
  }
}

function parseBingHtmlResults(html: string): WebSearchResult[] {
  const root = parse(html);
  const results: WebSearchResult[] = [];
  for (const algo of root.querySelectorAll("li.b_algo")) {
    const link = algo.querySelector("h2 a");
    if (link === null) {
      continue;
    }
    const rawUrl = link.getAttribute("href");
    const title = link.text.trim();
    if (rawUrl === undefined || title.length === 0) {
      continue;
    }
    const snippet =
      algo.querySelector(".b_caption p")?.text.trim() ??
      algo.querySelector("p")?.text.trim() ??
      "";
    results.push({
      snippet,
      title,
      url: rawUrl
    });
  }
  return results;
}

function parseDuckDuckGoHtmlResults(html: string): WebSearchResult[] {
  const root = parse(html);
  const anchors = root.querySelectorAll("a.result__a");
  const results: WebSearchResult[] = [];
  for (const anchor of anchors) {
    const rawUrl = anchor.getAttribute("href");
    const title = anchor.text.trim();
    if (rawUrl === undefined || title.length === 0) {
      continue;
    }
    const url = normalizeDuckDuckGoResultUrl(rawUrl);
    if (url === null) {
      continue;
    }
    const resultBlock = anchor.closest(".result");
    const snippet =
      resultBlock?.querySelector(".result__snippet")?.text.trim() ??
      resultBlock?.querySelector(".result__extras")?.text.trim() ??
      "";
    results.push({
      snippet,
      title,
      url
    });
  }
  return results;
}

function normalizeDuckDuckGoResultUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
    const parsed = new URL(absolute, "https://duckduckgo.com");
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.pathname === "/l/") {
      const redirect = parsed.searchParams.get("uddg");
      if (redirect !== null && redirect.trim().length > 0) {
        return decodeURIComponent(redirect);
      }
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
