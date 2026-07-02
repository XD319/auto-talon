import { describe, expect, it } from "vitest";

import { pinUserMessagesFromRecords } from "../src/runtime/sessions/session-user-message-pin.js";
import type { SessionMessageRecord } from "../src/types/index.js";

describe("session user message pin", () => {
  it("deduplicates and caps pinned user messages", () => {
    const records: SessionMessageRecord[] = [
      createUserMessage("first request"),
      createUserMessage("second request"),
      createUserMessage("second request")
    ];
    expect(pinUserMessagesFromRecords(records)).toEqual(["first request", "second request"]);
  });
});

function createUserMessage(text: string): SessionMessageRecord {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    entrySource: "tui",
    kind: "user",
    messageId: `user:${text}`,
    payload: { id: `user:${text}`, kind: "user", text, timestamp: "2026-01-01T00:00:00.000Z" },
    sequence: 1,
    sessionId: "session-1"
  };
}
