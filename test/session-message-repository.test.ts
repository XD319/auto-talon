import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("session message repository", () => {
  it("stores, replaces, and searches session messages", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        metadata: { source: "tui" },
        ownerUserId: "local-user",
        providerName: "test",
        sessionId: "session-a",
        title: "Alpha"
      });

      storage.sessionMessages.append({
        kind: "user",
        messageId: "user-1",
        payload: { id: "user-1", kind: "user", text: "hello gateway world", timestamp: "2026-01-01T00:00:00.000Z" },
        sessionId: "session-a"
      });
      storage.sessionMessages.append({
        kind: "agent",
        messageId: "agent-1",
        payload: {
          id: "agent-1",
          kind: "agent",
          text: "acknowledged gateway world",
          timestamp: "2026-01-01T00:00:01.000Z"
        },
        sessionId: "session-a"
      });

      expect(storage.sessionMessages.countBySessionId("session-a")).toBe(2);
      const hits = storage.sessionMessages.search({ limit: 5, query: "gateway" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.sessionId).toBe("session-a");

      storage.sessionMessages.replaceAll("session-a", [
        {
          kind: "user",
          messageId: "user-2",
          payload: { id: "user-2", kind: "user", text: "replaced", timestamp: "2026-01-02T00:00:00.000Z" },
          sessionId: "session-a"
        }
      ]);
      expect(storage.sessionMessages.countBySessionId("session-a")).toBe(1);
      expect(storage.sessionMessages.listBySessionId("session-a")[0]?.messageId).toBe("user-2");
    } finally {
      storage.close();
    }
  });

  it("treats append as an upsert for the same message_id", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        metadata: { source: "cli" },
        ownerUserId: "local-user",
        providerName: "test",
        sessionId: "session-upsert",
        title: "Upsert"
      });

      storage.sessionMessages.append({
        kind: "user",
        messageId: "user:task-1",
        payload: { id: "user:task-1", kind: "user", text: "first", timestamp: "2026-01-01T00:00:00.000Z" },
        sessionId: "session-upsert"
      });
      storage.sessionMessages.append({
        kind: "user",
        messageId: "user:task-1",
        payload: { id: "user:task-1", kind: "user", text: "second", timestamp: "2026-01-01T00:00:01.000Z" },
        sessionId: "session-upsert"
      });

      expect(storage.sessionMessages.countBySessionId("session-upsert")).toBe(1);
      const payload = storage.sessionMessages.listBySessionId("session-upsert")[0]?.payload;
      expect(payload?.text).toBe("second");
    } finally {
      storage.close();
    }
  });

  it("dedupes duplicate message ids during replaceAll", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        metadata: { source: "tui" },
        ownerUserId: "local-user",
        providerName: "test",
        sessionId: "session-dedupe",
        title: "Dedupe"
      });

      storage.sessionMessages.replaceAll("session-dedupe", [
        {
          kind: "system",
          messageId: "system:welcome",
          payload: { id: "system:welcome", kind: "system", text: "first", timestamp: "2026-01-01T00:00:00.000Z" },
          sessionId: "session-dedupe"
        },
        {
          kind: "system",
          messageId: "system:welcome",
          payload: { id: "system:welcome", kind: "system", text: "second", timestamp: "2026-01-01T00:00:01.000Z" },
          sessionId: "session-dedupe"
        }
      ]);

      expect(storage.sessionMessages.countBySessionId("session-dedupe")).toBe(1);
      expect(storage.sessionMessages.listBySessionId("session-dedupe")[0]?.payload.text).toBe("second");
    } finally {
      storage.close();
    }
  });

  it("allows the same chat message id across different sessions", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      for (const sessionId of ["session-a", "session-b"]) {
        storage.sessions.create({
          agentProfileId: "executor",
          cwd: process.cwd(),
          metadata: { source: "tui" },
          ownerUserId: "local-user",
          providerName: "test",
          sessionId,
          title: sessionId
        });
        storage.sessionMessages.replaceAll(sessionId, [
          {
            kind: "system",
            messageId: "system:welcome",
            payload: {
              id: "system:welcome",
              kind: "system",
              text: `Welcome ${sessionId}`,
              timestamp: "2026-01-01T00:00:00.000Z"
            },
            sessionId
          }
        ]);
      }

      expect(storage.sessionMessages.countBySessionId("session-a")).toBe(1);
      expect(storage.sessionMessages.countBySessionId("session-b")).toBe(1);
      expect(storage.sessionMessages.listBySessionId("session-a")[0]?.payload.text).toBe("Welcome session-a");
      expect(storage.sessionMessages.listBySessionId("session-b")[0]?.payload.text).toBe("Welcome session-b");
    } finally {
      storage.close();
    }
  });

  it("searches Chinese session messages with OR-style FTS tokens", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: process.cwd(),
        metadata: { source: "tui" },
        ownerUserId: "local-user",
        providerName: "test",
        sessionId: "session-zh",
        title: "Chinese"
      });
      storage.sessionMessages.append({
        kind: "agent",
        messageId: "agent-zh-1",
        payload: {
          id: "agent-zh-1",
          kind: "agent",
          text: "后续可添加的功能建议：排行榜、皮肤选择、音效系统",
          timestamp: "2026-01-01T00:00:00.000Z"
        },
        sessionId: "session-zh"
      });

      const hits = storage.sessionMessages.search({ limit: 5, query: "功能建议" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.preview).toMatch(/功能|建议|排行榜/u);
    } finally {
      storage.close();
    }
  });

  it("persists gateway runtime_session_id on bindings", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const binding = storage.gatewaySessions.create({
        adapterId: "feishu",
        externalSessionId: "chat-1",
        externalUserId: null,
        metadata: {},
        runtimeSessionId: "session-gw",
        runtimeUserId: "feishu:session:chat-1",
        sessionBindingId: "bind-1",
        taskId: "task-1"
      });
      expect(binding.runtimeSessionId).toBe("session-gw");
    } finally {
      storage.close();
    }
  });
});
