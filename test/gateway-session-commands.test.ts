import { describe, expect, it } from "vitest";

import { tryHandleGatewayResumeCommand } from "../src/gateway/session-commands.js";
import { createApplication } from "../src/runtime/index.js";

describe("gateway session commands", () => {
  it("lists and resumes runtime sessions for an external chat", () => {
    const handle = createApplication(process.cwd(), {
      config: { databasePath: ":memory:" }
    });
    try {
      const ownerUserId = "gateway-user";
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: process.cwd(),
        ownerUserId,
        title: "Gateway switch target"
      });
      handle.service.saveSessionUiState(session.sessionId, {
        entrySource: "gateway",
        messages: [{ id: "user:1", kind: "user", text: "hello", timestamp: "2026-01-01T00:00:00.000Z" }],
        title: "Gateway switch target"
      });

      const list = tryHandleGatewayResumeCommand({
        adapterId: "lineage-sdk",
        externalSessionId: "chat-1",
        externalUserId: null,
        ownerUserId,
        runtimeUserId: "lineage-sdk:session:chat-1",
        sessions: handle.service,
        taskInput: "/sessions"
      });
      expect(list.handled).toBe(true);
      if (list.handled) {
        expect(list.message).toContain("Active session: none");
        expect(list.message).toContain(session.sessionId.slice(0, 8));
      }

      const switched = tryHandleGatewayResumeCommand({
        adapterId: "lineage-sdk",
        externalSessionId: "chat-1",
        externalUserId: null,
        ownerUserId,
        runtimeUserId: "lineage-sdk:session:chat-1",
        sessions: handle.service,
        taskInput: `/resume ${session.sessionId.slice(0, 8)}`
      });
      expect(switched.handled).toBe(true);
      if (switched.handled) {
        expect(switched.message).toContain("Resumed session");
      }
      expect(handle.service.resolveGatewayRuntimeSessionId("lineage-sdk", "chat-1")).toBe(session.sessionId);

      const activeList = tryHandleGatewayResumeCommand({
        adapterId: "lineage-sdk",
        externalSessionId: "chat-1",
        externalUserId: null,
        ownerUserId,
        runtimeUserId: "lineage-sdk:session:chat-1",
        sessions: handle.service,
        taskInput: "/sessions"
      });
      expect(activeList.handled).toBe(true);
      if (activeList.handled) {
        expect(activeList.message).toContain(`Active session: ${session.sessionId.slice(0, 8)}`);
      }
    } finally {
      handle.close();
    }
  });

  it("does not handle removed /session commands", () => {
    const handle = createApplication(process.cwd(), {
      config: { databasePath: ":memory:" }
    });
    try {
      for (const taskInput of ["/session list", "/session switch abc", "/session summary"]) {
        const result = tryHandleGatewayResumeCommand({
          adapterId: "lineage-sdk",
          externalSessionId: "chat-1",
          externalUserId: null,
          ownerUserId: "gateway-user",
          runtimeUserId: "lineage-sdk:session:chat-1",
          sessions: handle.service,
          taskInput
        });
        expect(result.handled).toBe(false);
      }
    } finally {
      handle.close();
    }
  });
});
