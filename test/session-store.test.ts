import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadSession, saveSession } from "../src/tui/session-store.js";
import type { ChatMessage } from "../src/tui/view-models/chat-messages.js";
import type { TraceEvent } from "../src/types/index.js";

describe("tui session store", () => {
  it("persists interaction mode with saved chat sessions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-session-store-"));
    try {
      await saveSession(workspaceRoot, {
        id: "session-1",
        interactionMode: "plan",
        messages: [],
        title: "planning",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });

      const loaded = await loadSession(workspaceRoot, "session-1");

      expect(loaded?.interactionMode).toBe("plan");
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });

  it("compacts trace activity when saving and loading sessions", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-session-store-"));
    try {
      const messages: ChatMessage[] = [
        {
          id: "user-1",
          kind: "user",
          text: "prompt",
          timestamp: "2026-01-01T00:00:00.000Z"
        },
        {
          event: createTraceEvent("tool_call_started", {
            iteration: 1,
            toolCallId: "call-low",
            toolName: "file_read"
          }),
          id: "activity:low",
          kind: "activity",
          text: "Running file_read",
          timestamp: "2026-01-01T00:00:01.000Z"
        },
        {
          event: createTraceEvent("tool_call_failed", {
            errorCode: "sandbox_denied",
            errorMessage: "not allowed",
            iteration: 1,
            toolCallId: "call-high",
            toolName: "shell"
          }),
          id: "activity:high",
          kind: "activity",
          text: "shell failed",
          timestamp: "2026-01-01T00:00:02.000Z"
        },
        {
          event: {
            ...createTraceEvent("tool_call_failed", {
              errorCode: "sandbox_denied",
              errorMessage: "not allowed",
              iteration: 2,
              toolCallId: "call-high-duplicate",
              toolName: "shell"
            }),
            eventId: "event-tool_call_failed-duplicate"
          },
          id: "activity:high-duplicate",
          kind: "activity",
          text: "shell failed",
          timestamp: "2026-01-01T00:00:03.000Z"
        }
      ];

      await saveSession(workspaceRoot, {
        id: "session-activity",
        messages,
        title: "activity",
        updatedAt: "2026-01-01T00:00:03.000Z"
      });

      const raw = await readFile(join(workspaceRoot, ".auto-talon", "sessions", "session-activity.json"), "utf8");
      const saved = JSON.parse(raw) as { messages: ChatMessage[] };
      const loaded = await loadSession(workspaceRoot, "session-activity");

      expect(saved.messages.map((message) => message.id)).toEqual(["user-1", "activity:high"]);
      expect(loaded?.messages.map((message) => message.id)).toEqual(["user-1", "activity:high"]);
    } finally {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});

function createTraceEvent<TType extends TraceEvent["eventType"]>(
  eventType: TType,
  payload: Extract<TraceEvent, { eventType: TType }>["payload"]
): Extract<TraceEvent, { eventType: TType }> {
  return {
    actor: "test",
    eventId: `event-${eventType}`,
    eventType,
    payload,
    sequence: 1,
    stage: "tooling",
    summary: eventType,
    taskId: "task-1",
    timestamp: "2026-01-01T00:00:00.000Z"
  } as Extract<TraceEvent, { eventType: TType }>;
}
