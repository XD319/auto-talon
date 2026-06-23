import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/providers/provider-error.js";
import { classifyStreamingFallback } from "../src/providers/streaming-fallback.js";

describe("classifyStreamingFallback", () => {
  it("treats invalid_request as ineligible so the same payload is not retried non-streaming", () => {
    const error = new ProviderError({
      category: "invalid_request",
      message: "An assistant message with 'tool_calls' must be followed by tool messages",
      providerName: "deepseek",
      retriable: false,
      summary: "The provider rejected the request payload."
    });
    expect(classifyStreamingFallback(error)).toBe("ineligible");
  });

  it("treats unsupported_capability as persistent", () => {
    const error = new ProviderError({
      category: "unsupported_capability",
      message: "streaming not supported",
      providerName: "mock",
      retriable: false,
      summary: "unsupported"
    });
    expect(classifyStreamingFallback(error)).toBe("persistent");
  });

  it("treats transient network errors as transient", () => {
    const error = new ProviderError({
      category: "transient_network_error",
      message: "fetch failed",
      providerName: "openai",
      retriable: true,
      summary: "network"
    });
    expect(classifyStreamingFallback(error)).toBe("transient");
  });
});
