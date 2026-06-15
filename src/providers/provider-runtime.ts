import type {
  Provider,
  ProviderConfig,
  ProviderErrorCategory,
  ProviderErrorShape,
  ProviderHealthCheck,
  ProviderRequest,
  ProviderResponse,
  ProviderStatsSnapshot,
  ProviderStreamEvent
} from "../types/index.js";

import { ProviderError } from "./provider-error.js";
import { assertProviderResponse, withRetryCount } from "./provider-contract.js";
import { ProviderTelemetry } from "./provider-telemetry.js";

export class ManagedProvider implements Provider {
  private readonly telemetry: ProviderTelemetry;

  public readonly capabilities: Provider["capabilities"];
  public readonly describe: Provider["describe"];
  public readonly fetchContextWindow: Provider["fetchContextWindow"];
  public readonly model: string | undefined;
  public readonly name: string;
  public readonly streamGenerate: Provider["streamGenerate"];
  public readonly testConnection: Provider["testConnection"];

  public constructor(
    private readonly inner: Provider,
    private readonly config: Pick<ProviderConfig, "maxRetries">
  ) {
    this.capabilities = inner.capabilities;
    this.describe = inner.describe?.bind(inner);
    this.fetchContextWindow = inner.fetchContextWindow?.bind(inner) as
      | ((signal?: AbortSignal) => Promise<number | null>)
      | undefined;
    this.model = inner.model;
    this.name = inner.name;
    this.telemetry = new ProviderTelemetry(inner.name);
    this.streamGenerate = inner.streamGenerate?.bind(inner) as
      | ((input: ProviderRequest) => AsyncIterable<ProviderStreamEvent>)
      | undefined;
    this.testConnection = inner.testConnection?.bind(inner) as
      | ((signal?: AbortSignal) => Promise<ProviderHealthCheck>)
      | undefined;
  }

  public getStats(): ProviderStatsSnapshot {
    return this.telemetry.snapshot();
  }

  public async generate(input: ProviderRequest): Promise<ProviderResponse> {
    const startedAt = Date.now();
    let retryCount = 0;
    let lastError: ProviderError | null = null;
    let streamedTextVisible = false;
    const managedInput =
      input.onTextDelta === undefined
        ? input
        : {
            ...input,
            onTextDelta: (delta: string) => {
              if (delta.length > 0) {
                streamedTextVisible = true;
              }
              input.onTextDelta?.(delta);
            }
          };

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        const response = await this.inner.generate(managedInput);
        const validated = assertProviderResponse(response, this.name, this.model);
        const completed = withRetryCount(validated, retryCount);
        this.telemetry.recordSuccess(Date.now() - startedAt, completed.usage, retryCount);
        return completed;
      } catch (error) {
        const normalized = toProviderError(error, this.name, this.model, retryCount);
        lastError = normalized;

        if (!normalized.retriable || streamedTextVisible || attempt >= this.config.maxRetries) {
          this.telemetry.recordFailure(Date.now() - startedAt, normalized.category, retryCount);
          throw normalized;
        }

        retryCount += 1;
        const delayMs = computeRetryDelayMs(retryCount);
        input.onRetry?.({
          attempt: retryCount,
          delayMs,
          errorCategory: normalized.category,
          maxRetries: this.config.maxRetries,
          modelName: this.model ?? null,
          providerName: this.name
        });
        await waitBeforeRetry(delayMs);
      }
    }

    const finalError =
      lastError ??
      new ProviderError({
        category: "unknown_error",
        message: "Provider request failed.",
        providerName: this.name,
        retriable: false,
        retryCount
      });
    this.telemetry.recordFailure(Date.now() - startedAt, finalError.category, retryCount);
    throw finalError;
  }

}

export function toProviderError(
  error: unknown,
  providerName: string,
  modelName?: string,
  retryCount = 0
): ProviderError {
  if (error instanceof ProviderError) {
    return enrichProviderError(error, retryCount);
  }

  if (isTimeoutAbortError(error)) {
    return new ProviderError({
      category: "timeout_error",
      cause: error,
      message: "Provider request timed out.",
      modelName,
      providerName,
      retriable: true,
      retryCount,
      summary: "The provider request timed out."
    });
  }

  if (error instanceof Error) {
    return new ProviderError({
      category: "transient_network_error",
      cause: error,
      message: error.message,
      modelName,
      providerName,
      retriable: true,
      retryCount,
      summary: "A transient network error interrupted the provider request."
    });
  }

  return new ProviderError({
    category: "unknown_error",
    cause: error,
    message: "Unknown provider error.",
    modelName,
    providerName,
    retriable: false,
    retryCount,
    summary: "The provider failed with an unknown error."
  });
}

function isTimeoutAbortError(error: unknown): boolean {
  if (error === "timeout") {
    return true;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" || error.message.toLowerCase().includes("timeout");
  }
  return false;
}

export function createProviderError(shape: ProviderErrorShape): ProviderError {
  return new ProviderError(shape);
}

export function classifyProviderHttpError(
  statusCode: number | undefined,
  errorType?: string,
  errorCode?: string
): ProviderErrorCategory {
  const normalizedType = errorType?.toLowerCase();
  const normalizedCode = errorCode?.toLowerCase();

  if (statusCode === 401 || statusCode === 403 || normalizedType?.includes("auth") === true) {
    return "auth_error";
  }

  if (statusCode === 400 || statusCode === 404 || normalizedType?.includes("invalid") === true) {
    return "invalid_request";
  }

  if (
    statusCode === 408 ||
    normalizedType?.includes("timeout") === true ||
    normalizedCode?.includes("timeout") === true
  ) {
    return "timeout_error";
  }

  if (statusCode === 429 || normalizedType?.includes("rate") === true) {
    return "rate_limit";
  }

  if (
    statusCode === 501 ||
    normalizedType?.includes("unsupported") === true ||
    normalizedCode?.includes("unsupported") === true
  ) {
    return "unsupported_capability";
  }

  if (
    (statusCode !== undefined && statusCode >= 500) ||
    normalizedType?.includes("unavailable") === true ||
    normalizedCode?.includes("unavailable") === true
  ) {
    return "provider_unavailable";
  }

  return "unknown_error";
}

export function isRetriableCategory(category: ProviderErrorCategory): boolean {
  return (
    category === "transient_network_error" ||
    category === "timeout_error" ||
    category === "rate_limit" ||
    category === "provider_unavailable"
  );
}

function enrichProviderError(error: ProviderError, retryCount: number): ProviderError {
  return new ProviderError({
    category: error.category,
    cause: error.cause,
    details: error.details,
    message: error.message,
    modelName: error.modelName,
    providerName: error.providerName,
    retriable: error.retriable,
    retryCount,
    statusCode: error.statusCode,
    summary: error.summary
  });
}

function computeRetryDelayMs(retryCount: number): number {
  const exponential = Math.min(250 * 2 ** Math.max(0, retryCount - 1), 4_000);
  return exponential + Math.floor(Math.random() * Math.min(125, exponential / 4 + 1));
}

async function waitBeforeRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
