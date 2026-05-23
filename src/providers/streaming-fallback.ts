import type { ProviderRequest, ProviderResponse } from "../types/index.js";

import type { ProviderError } from "./provider-error.js";

/**
 * Categorizes a streaming failure into a strategy:
 * - `persistent`: the endpoint signalled it cannot stream (e.g. 4xx-shaped responses).
 *   Fall back to non-streaming for the rest of the session.
 * - `transient`: the failure looks like a one-off network hiccup (timeout, abort,
 *   `TypeError: fetch failed`, etc.). Fall back for THIS request only and try
 *   streaming again on the next request, until the consecutive-failure budget
 *   is exhausted.
 * - `ineligible`: the failure is not safe to retry as a non-streaming request
 *   (e.g. auth errors, rate limits). The error must propagate.
 */
export type StreamingFallbackKind = "persistent" | "transient" | "ineligible";

/**
 * Default number of consecutive transient streaming failures before the provider
 * gives up and persistently disables streaming for the session.
 */
export const DEFAULT_STREAMING_TRANSIENT_FAILURE_LIMIT = 3;

export function classifyStreamingFallback(error: unknown): StreamingFallbackKind {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "transient";
  }
  const category = (error as Partial<ProviderError> | null | undefined)?.category;
  if (category === "unsupported_capability" || category === "invalid_request" || category === "malformed_response") {
    return "persistent";
  }
  if (category === "auth_error" || category === "rate_limit") {
    // Auth/rate-limit problems will keep failing on the non-streaming path too,
    // so propagate the original error instead of looping fallbacks.
    return "ineligible";
  }
  if (
    category === "timeout_error" ||
    category === "transient_network_error" ||
    category === "provider_unavailable" ||
    category === "unknown_error"
  ) {
    return "transient";
  }
  if (error instanceof Error) {
    // Unknown raw errors (e.g. `TypeError: fetch failed` thrown before classification)
    // are treated as transient – the non-streaming follow-up will surface a real error
    // if the issue persists.
    return "transient";
  }
  return "ineligible";
}

export function describeStreamingFallbackReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "streaming request failed before producing output";
}

/**
 * Tracks streaming health across requests for a single provider instance.
 * Persistent failures stick for the lifetime of the provider; transient failures
 * accumulate and only persistently disable streaming after a configurable budget
 * is exhausted. Successful streaming resets the transient counter.
 */
export class StreamingFallbackState {
  private permanentlyDisabled = false;
  private permanentReason: string | null = null;
  private consecutiveTransient = 0;
  private noticeEmitted = false;

  public constructor(
    private readonly transientFailureLimit: number = DEFAULT_STREAMING_TRANSIENT_FAILURE_LIMIT
  ) {}

  public isStreamingDisabled(): boolean {
    return this.permanentlyDisabled;
  }

  public reasonForDisable(): string | null {
    return this.permanentReason;
  }

  /** Reset transient counters after a streaming attempt that produced output. */
  public recordSuccess(): void {
    this.consecutiveTransient = 0;
  }

  /**
   * Record a streaming failure and decide what to emit. The caller should still
   * fall back to non-streaming for the current request when this returns
   * `transient` or `persistent`.
   */
  public recordFailure(
    input: ProviderRequest,
    kind: "persistent" | "transient",
    reason: string,
    emit: StreamingFallbackNoticeEmitter
  ): void {
    if (kind === "persistent") {
      this.markPermanent(input, reason, emit);
      return;
    }
    this.consecutiveTransient += 1;
    if (this.consecutiveTransient >= this.transientFailureLimit) {
      this.markPermanent(
        input,
        `${reason} (after ${this.consecutiveTransient} consecutive transient streaming failures)`,
        emit
      );
    }
  }

  private markPermanent(
    input: ProviderRequest,
    reason: string,
    emit: StreamingFallbackNoticeEmitter
  ): void {
    if (this.permanentlyDisabled) {
      return;
    }
    this.permanentlyDisabled = true;
    this.permanentReason = reason;
    this.consecutiveTransient = 0;
    if (this.noticeEmitted) {
      return;
    }
    this.noticeEmitted = true;
    emit(input, reason);
  }
}

export type StreamingFallbackNoticeEmitter = (input: ProviderRequest, reason: string) => void;

/**
 * Returns true when a streaming response completed without any usable signal
 * (no events, no text, no tool calls). Both providers treat that as a transient
 * failure and retry with `stream: false` for that request.
 */
export function shouldFallbackFromEmptyStream(
  response: ProviderResponse,
  progress: { madeProgress: boolean; sawEvent: boolean }
): boolean {
  if (progress.madeProgress) {
    return false;
  }
  if (!progress.sawEvent) {
    return true;
  }
  if (response.kind === "tool_calls") {
    return response.toolCalls.length === 0 && response.message.length === 0;
  }
  return response.kind === "final" && response.message.length === 0;
}
