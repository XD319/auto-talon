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
