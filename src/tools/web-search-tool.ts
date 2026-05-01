import { z } from "zod";

import type { WebSearchRuntimeConfig } from "../runtime/runtime-config.js";
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

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
}

export interface WebSearchResponse {
  provider: string;
  query: string;
  results: WebSearchResult[];
}

export interface WebSearchClientInput {
  apiKey: string;
  apiUrl: string;
  domains?: string[];
  maxResults: number;
  query: string;
  recencyDays?: number;
  signal: AbortSignal;
}

export interface WebSearchClient {
  search(input: WebSearchClientInput): Promise<WebSearchResponse>;
}

interface PreparedWebSearchInput {
  domains?: string[];
  maxResults: number;
  plan: SandboxWebPlan;
  query: string;
  recencyDays?: number;
}

const webSearchSchema = z.object({
  domains: z.array(z.string().min(1)).max(20).optional(),
  maxResults: z.number().int().positive().max(50).default(5),
  query: z.string().min(1),
  recencyDays: z.number().int().positive().max(365).optional()
});

export class WebSearchTool implements ToolDefinition<typeof webSearchSchema, PreparedWebSearchInput> {
  public readonly name = "web_search";
  public readonly description =
    "Search the public web and return normalized search results for follow-up web_fetch reads.";
  public readonly capability = "network.fetch_public_readonly" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "cheap" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = webSearchSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      domains: {
        type: "array"
      },
      maxResults: {
        type: "number"
      },
      query: {
        type: "string"
      },
      recencyDays: {
        type: "number"
      }
    },
    required: ["query"],
    type: "object"
  };

  public constructor(
    private readonly sandboxService: SandboxService,
    private readonly config: WebSearchRuntimeConfig,
    private readonly client: WebSearchClient = new FirecrawlWebSearchClient()
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    if (this.config.backend === "disabled") {
      return {
        available: false,
        reason: "web_search backend is disabled"
      };
    }
    if (this.config.backend === "firecrawl" && this.config.apiKey === null) {
      return {
        available: false,
        reason: `${this.config.apiKeyEnv} is required for Firecrawl web_search`
      };
    }
    return {
      available: true,
      reason: `web_search backend ${this.config.backend} is configured`
    };
  }

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedWebSearchInput> {
    void context;
    const parsedInput = this.inputSchema.parse(input);
    const endpointPlan = this.sandboxService.prepareWebFetch(this.config.apiUrl);
    const plan: SandboxWebPlan = {
      ...endpointPlan,
      method: "POST"
    };

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Search web for ${parsedInput.query}`
      },
      preparedInput: {
        ...(parsedInput.domains !== undefined ? { domains: parsedInput.domains } : {}),
        maxResults: Math.min(parsedInput.maxResults, this.config.maxResults),
        plan,
        query: parsedInput.query,
        ...(parsedInput.recencyDays !== undefined ? { recencyDays: parsedInput.recencyDays } : {})
      },
      sandbox: plan
    };
  }

  public async execute(input: PreparedWebSearchInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (this.config.backend === "disabled" || this.config.apiKey === null) {
      return {
        errorCode: "tool_validation_error",
        errorMessage: "web_search is unavailable because no backend/API key is configured.",
        success: false
      };
    }

    try {
      const output = await this.client.search({
        apiKey: this.config.apiKey,
        apiUrl: input.plan.url,
        ...(input.domains !== undefined ? { domains: input.domains } : {}),
        maxResults: input.maxResults,
        query: input.query,
        ...(input.recencyDays !== undefined ? { recencyDays: input.recencyDays } : {}),
        signal: context.signal
      });
      return {
        artifacts: [
          {
            artifactType: "web_search_results",
            content: output as unknown as JsonObject,
            uri: input.plan.url
          }
        ],
        output: output as unknown as JsonObject,
        success: true,
        summary: `Found ${output.results.length} web results for ${input.query}`
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown web_search provider error.";
      return {
        details: {
          provider: this.config.backend,
          url: input.plan.url
        },
        errorCode: "tool_execution_error",
        errorMessage: message,
        success: false
      };
    }
  }
}

export class FirecrawlWebSearchClient implements WebSearchClient {
  public async search(input: WebSearchClientInput): Promise<WebSearchResponse> {
    const response = await fetch(input.apiUrl, {
      body: JSON.stringify({
        ...(input.domains !== undefined ? { filter: { domains: input.domains } } : {}),
        limit: input.maxResults,
        query: input.query,
        ...(input.recencyDays !== undefined ? { tbs: `qdr:d${input.recencyDays}` } : {})
      }),
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      method: "POST",
      signal: input.signal
    });
    const text = await response.text();
    const parsed = parseJsonObject(text);
    if (!response.ok) {
      throw new Error(`Firecrawl search failed with HTTP status ${response.status}.`);
    }
    const sourceResults = extractFirecrawlResults(parsed);
    return {
      provider: "firecrawl",
      query: input.query,
      results: sourceResults.slice(0, input.maxResults)
    };
  }
}

function parseJsonObject(text: string): JsonObject {
  if (text.trim().length === 0) {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as JsonObject)
    : {};
}

function extractFirecrawlResults(payload: JsonObject): WebSearchResult[] {
  const candidates = [payload.data, payload.results, payload.items].find(Array.isArray) as unknown[] | undefined;
  if (candidates === undefined) {
    return [];
  }
  return candidates.flatMap((item) => normalizeFirecrawlItem(item));
}

function normalizeFirecrawlItem(item: unknown): WebSearchResult[] {
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
    "";
  const publishedAt = readString(record.publishedAt) ?? readString(record.publishedDate) ?? readString(record.date);
  return [
    {
      ...(publishedAt !== null ? { publishedAt } : {}),
      snippet,
      title,
      url
    }
  ];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
