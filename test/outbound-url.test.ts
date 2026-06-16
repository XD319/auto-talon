import { describe, expect, it } from "vitest";

import { validateOutboundUrl } from "../src/core/outbound-url.js";
import { AppError } from "../src/core/app-error.js";

describe("outbound url validation", () => {
  it("allows public https urls", () => {
    expect(validateOutboundUrl("https://example.com/hook").hostname).toBe("example.com");
  });

  it("blocks localhost webhook targets", () => {
    expect(() => validateOutboundUrl("http://127.0.0.1/hook")).toThrow(AppError);
    expect(() => validateOutboundUrl("http://localhost/hook")).toThrow(AppError);
  });
});
