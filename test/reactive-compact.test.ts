import { describe, expect, it } from "vitest";

import { ProviderError } from "../src/providers/provider-error.js";
import {
  dropOldestNonSystemMessages,
  isContextOverflowProviderError
} from "../src/runtime/context/reactive-compact.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("reactive compact", () => {
  it("detects context overflow provider errors", () => {
    expect(
      isContextOverflowProviderError(
        new ProviderError({
          category: "invalid_request",
          message: "prompt is too long for the model context window",
          providerName: "openai"
        })
      )
    ).toBe(true);
    expect(
      isContextOverflowProviderError(
        new ProviderError({
          category: "invalid_request",
          message: "bad request",
          providerName: "openai",
          statusCode: 413
        })
      )
    ).toBe(true);
  });

  it("drops the oldest non-system message", () => {
    const messages: ConversationMessage[] = [
      { content: "system", role: "system" },
      { content: "old user", role: "user" },
      { content: "new user", role: "user" }
    ];
    expect(dropOldestNonSystemMessages(messages)).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["system", "new user"]);
  });
});
