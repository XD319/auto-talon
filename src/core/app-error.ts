import {
  RUNTIME_ERROR_CODES,
  type ProviderErrorShape,
  type RuntimeErrorCode,
  type RuntimeErrorShape
} from "../types/index.js";

export class AppError extends Error implements RuntimeErrorShape {
  public readonly code: RuntimeErrorCode;
  public readonly details: Record<string, unknown> | undefined;
  public override readonly cause: unknown;

  public constructor(shape: RuntimeErrorShape) {
    super(shape.message);
    this.name = "AppError";
    this.code = shape.code;
    this.details = shape.details;
    this.cause = shape.cause;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const providerError = readProviderError(error);
  if (providerError !== null) {
    return new AppError({
      cause: error,
      code: "provider_error",
      details: {
        providerErrorSummary: providerError.summary,
        providerCategory: providerError.category,
        providerName: providerError.providerName,
        modelName: providerError.modelName ?? null,
        retriable: providerError.retriable,
        retryCount: providerError.retryCount,
        statusCode: providerError.statusCode ?? null
      },
      message: providerError.message
    });
  }

  const coded = readRuntimeErrorCode(error);
  if (coded !== null) {
    const message = error instanceof Error ? error.message : String(error);
    return new AppError({
      cause: error,
      code: coded,
      message
    });
  }

  if (error instanceof Error) {
    return new AppError({
      cause: error,
      code: "internal_error",
      message: error.message
    });
  }

  return new AppError({
    cause: error,
    code: "internal_error",
    message: "Unknown error"
  });
}

function readRuntimeErrorCode(error: unknown): RuntimeErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = error.code;
  if (typeof code !== "string") {
    return null;
  }
  return (RUNTIME_ERROR_CODES as readonly string[]).includes(code)
    ? (code as RuntimeErrorCode)
    : null;
}

function readProviderError(error: unknown): ProviderErrorShape | null {
  if (!(error instanceof Error) || error.name !== "ProviderError") {
    return null;
  }

  const candidate = error as Partial<ProviderErrorShape>;
  if (
    typeof candidate.category !== "string" ||
    typeof candidate.providerName !== "string" ||
    typeof candidate.retriable !== "boolean"
  ) {
    return null;
  }

  return {
    category: candidate.category,
    cause: candidate.cause,
    details: candidate.details,
    message: error.message,
    modelName: candidate.modelName,
    providerName: candidate.providerName,
    retriable: candidate.retriable,
    retryCount: candidate.retryCount ?? 0,
    statusCode: candidate.statusCode,
    summary: candidate.summary ?? error.message
  };
}
