import { describe, expect, it } from "vitest";

import {
  assertSafeHttpBind,
  isLoopbackHost,
  readBearerToken,
  validateHttpBearerAuth
} from "../src/core/http-auth.js";
import { AppError } from "../src/core/app-error.js";

describe("http auth", () => {
  it("detects loopback hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("parses bearer tokens", () => {
    expect(readBearerToken("Bearer secret-token")).toBe("secret-token");
    expect(readBearerToken("Basic abc")).toBeNull();
  });

  it("validates bearer auth when token configured", () => {
    expect(validateHttpBearerAuth("Bearer abc", "abc")).toBe(true);
    expect(validateHttpBearerAuth("Bearer wrong", "abc")).toBe(false);
    expect(validateHttpBearerAuth(undefined, null)).toBe(true);
  });

  it("rejects non-loopback bind without token", () => {
    expect(() =>
      assertSafeHttpBind({
        cwd: process.cwd(),
        host: "0.0.0.0"
      })
    ).toThrow(AppError);
  });
});
