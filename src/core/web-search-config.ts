export type WebBackend =
  | "auto"
  | "brave"
  | "ddgs"
  | "disabled"
  | "exa"
  | "firecrawl"
  | "http"
  | "searxng"
  | "tavily";

export type WebSearchBackend = Exclude<WebBackend, "auto" | "http">;
export type WebExtractBackend = Exclude<WebBackend, "auto" | "brave" | "ddgs" | "searxng">;

export interface WebProviderRuntimeConfig {
  apiKey: string | null;
  apiKeyEnv: string | null;
  apiUrl: string | null;
}

export interface WebRuntimeConfig {
  backend: WebBackend;
  searchBackend: WebSearchBackend;
  extractBackend: WebExtractBackend;
  maxResults: number;
  longPageThresholdBytes: number;
  summaryTargetBytes: number;
  providers: {
    brave: WebProviderRuntimeConfig;
    ddgs: WebProviderRuntimeConfig;
    exa: WebProviderRuntimeConfig;
    firecrawl: WebProviderRuntimeConfig;
    searxng: WebProviderRuntimeConfig;
    tavily: WebProviderRuntimeConfig;
  };
}

export interface WebSearchRuntimeConfig {
  apiKey: string | null;
  apiKeyEnv: string;
  apiUrl: string;
  backend: "disabled" | "firecrawl";
  maxResults: number;
}

export const API_SEARCH_BACKEND_PRIORITY = [
  "firecrawl",
  "tavily",
  "exa",
  "brave",
  "searxng"
] as const satisfies readonly Exclude<WebSearchBackend, "ddgs" | "disabled">[];

export type ApiSearchBackend = (typeof API_SEARCH_BACKEND_PRIORITY)[number];

export function isConfiguredApiSearchBackend(
  backend: ApiSearchBackend,
  web: WebRuntimeConfig
): boolean {
  const provider = web.providers[backend];
  if (backend === "searxng") {
    return provider.apiUrl !== null;
  }
  return provider.apiKey !== null && provider.apiUrl !== null;
}

export function listConfiguredApiSearchBackends(web: WebRuntimeConfig): ApiSearchBackend[] {
  return API_SEARCH_BACKEND_PRIORITY.filter((backend) => isConfiguredApiSearchBackend(backend, web));
}

export function buildWebSearchRemediationHint(): string {
  return [
    "Configure an API-backed search provider:",
    "BRAVE_SEARCH_API_KEY (free tier), TAVILY_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, or SEARXNG_URL,",
    "or set web.searchBackend to \"auto\" or a specific provider in runtime.config.json."
  ].join(" ");
}

export function usesBestEffortDdgsSearch(web: WebRuntimeConfig): boolean {
  return web.searchBackend === "ddgs";
}
