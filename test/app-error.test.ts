import { describe, expect, it } from "vitest";

import { AppError, toAppError } from "../src/core/app-error.js";
import { ProviderError } from "../src/providers/provider-error.js";

describe("toAppError", () => {
  it("returns AppError unchanged", () => {
    const original = new AppError({ code: "sandbox_denied", message: "blocked" });
    expect(toAppError(original)).toBe(original);
  });

  it("maps ProviderError to provider_error", () => {
    const error = toAppError(
      new ProviderError({
        category: "timeout_error",
        message: "upstream timeout",
        providerName: "openai",
        retriable: true,
        summary: "timeout"
      })
    );
    expect(error.code).toBe("provider_error");
    expect(error.message).toBe("upstream timeout");
    expect(error.details?.providerName).toBe("openai");
  });

  it("keeps a valid RuntimeErrorCode from a plain error", () => {
    const original = Object.assign(new Error("tool exploded"), { code: "tool_execution_error" });
    const error = toAppError(original);
    expect(error.code).toBe("tool_execution_error");
    expect(error.message).toBe("tool exploded");
  });

  it("classifies unknown Error as internal_error", () => {
    const error = toAppError(new Error("EISDIR: illegal operation"));
    expect(error.code).toBe("internal_error");
    expect(error.message).toBe("EISDIR: illegal operation");
  });

  it("classifies non-Error values as internal_error", () => {
    const error = toAppError("boom");
    expect(error.code).toBe("internal_error");
    expect(error.message).toBe("Unknown error");
  });
});
