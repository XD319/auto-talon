export interface WebSearchRuntimeConfig {
  apiKey: string | null;
  apiKeyEnv: string;
  apiUrl: string;
  backend: "disabled" | "firecrawl";
  maxResults: number;
}
