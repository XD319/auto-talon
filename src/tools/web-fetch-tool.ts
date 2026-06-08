import { z } from "zod";
import { parse } from "node-html-parser";

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

export interface WebFetchClient {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

interface PreparedWebFetchInput {
  maxBytes: number;
  maxRedirects: number;
  plan: SandboxWebPlan;
}

const webFetchSchema = z.object({
  maxBytes: z.number().int().positive().max(200_000).default(32_768),
  maxRedirects: z.number().int().min(0).max(5).default(2),
  url: z.string().url()
});

export class WebFetchTool implements ToolDefinition<typeof webFetchSchema, PreparedWebFetchInput> {
  public readonly name = "web_fetch";
  public readonly description =
    "Fetch a public text-oriented HTTP resource through a sandboxed allowlist.";
  public readonly capability = "network.fetch_public_readonly" as const;
  public readonly riskLevel = "medium" as const;
  public readonly privacyLevel = "restricted" as const;
  public readonly costLevel = "cheap" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly approvalDefault = "when_needed" as const;
  public readonly toolKind = "external_tool" as const;
  public readonly inputSchema = webFetchSchema;

  public constructor(
    private readonly sandboxService: SandboxService,
    private readonly client: WebFetchClient = {
      fetch: (input, init) => fetch(input, init)
    }
  ) {}

  public checkAvailability(): ToolAvailabilityResult {
    return {
      available: true,
      reason: "web fetch availability controlled by sandbox host allowlist"
    };
  }

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<PreparedWebFetchInput> {
    void context;
    const parsedInput = this.inputSchema.parse(input);
    const plan = this.sandboxService.prepareWebFetch(parsedInput.url);

    return {
      governance: {
        pathScope: plan.pathScope,
        summary: `Fetch ${plan.url}`
      },
      preparedInput: {
        maxBytes: parsedInput.maxBytes,
        maxRedirects: parsedInput.maxRedirects,
        plan
      },
      sandbox: plan
    };
  }

  public async execute(
    input: PreparedWebFetchInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const requestTrace: Array<{ status: number; url: string }> = [];
    let response: Response;
    try {
      response = await this.followRedirects(
        input.plan.url,
        input.maxRedirects,
        requestTrace,
        context.signal
      );
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
      throw error;
    }
    const body = await response.text();
    const normalized = normalizeWebBody(body, response.headers.get("content-type"));
    const truncatedBody = normalized.content.slice(0, input.maxBytes);
    const responseUrl = response.url || input.plan.url;
    const summary = response.ok
      ? `Fetched ${responseUrl}`
      : `Fetched ${responseUrl} with HTTP ${response.status}`;

    return {
      artifacts: [
        {
          artifactType: "web_response",
          content: {
            body: truncatedBody,
            extractedTitle: normalized.title,
            headers: {
              contentType: response.headers.get("content-type")
            },
            ok: response.ok,
            redirectTrace: requestTrace,
            status: response.status,
            statusText: response.statusText,
            url: responseUrl
          },
          uri: responseUrl
        }
      ],
      output: {
        body: truncatedBody,
        contentType: response.headers.get("content-type"),
        extractedTitle: normalized.title,
        ok: response.ok,
        redirectTrace: requestTrace,
        status: response.status,
        statusText: response.statusText,
        truncated: normalized.content.length > truncatedBody.length,
        url: responseUrl
      },
      success: true,
      summary
    };
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

function normalizeWebBody(
  body: string,
  contentType: string | null
): {
  content: string;
  title: string | null;
} {
  if (contentType?.toLowerCase().includes("text/html") !== true) {
    return {
      content: body,
      title: null
    };
  }

  const root = parse(body);
  root.querySelectorAll("script,style,noscript,template").forEach((node) => node.remove());
  const title = root.querySelector("title")?.text.trim() ?? null;
  const text = root.text.replace(/\s+/gu, " ").trim();
  return {
    content: text,
    title
  };
}
