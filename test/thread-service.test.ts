import { describe, expect, it } from "vitest";

import { SessionService } from "../src/runtime/sessions/index.js";
import { StorageManager } from "../src/storage/database.js";

describe("session service", () => {
  it("creates and archives sessions with lineage", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const service = new SessionService({
        sessionLineageRepository: storage.sessionLineage,
        sessionRepository: storage.sessions,
        sessionTaskRepository: storage.sessionTasks
      });

      const session = service.getOrCreateSession({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u2",
        providerName: "mock",
        title: "service thread"
      });
      expect(service.listSessions()).toHaveLength(1);

      const archived = service.archiveSession(session.sessionId);
      expect(archived.status).toBe("archived");
      expect(storage.sessionLineage.listBySessionId(session.sessionId).at(-1)?.eventType).toBe("archive");
    } finally {
      storage.close();
    }
  });

  it("creates a missing session when a session id is provided", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const service = new SessionService({
        sessionLineageRepository: storage.sessionLineage,
        sessionRepository: storage.sessions,
        sessionTaskRepository: storage.sessionTasks
      });

      const recovered = service.getOrCreateSession({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u2",
        providerName: "mock",
        sessionId: "c5232d20-cccf-4825-b9e8-2e3509870025",
        title: "recovered session"
      });

      expect(recovered.sessionId).toBe("c5232d20-cccf-4825-b9e8-2e3509870025");
      expect(service.showSession(recovered.sessionId).session?.title).toBe("recovered session");
    } finally {
      storage.close();
    }
  });

  it("getOrCreate is idempotent at the repository layer", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const first = storage.sessions.getOrCreate({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u2",
        providerName: "mock",
        sessionId: "9e0a8b74-0a16-4914-a2dc-4b2f17dce0e6",
        title: "first"
      });
      const second = storage.sessions.getOrCreate({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u2",
        providerName: "mock",
        sessionId: "9e0a8b74-0a16-4914-a2dc-4b2f17dce0e6",
        title: "second"
      });

      expect(second.sessionId).toBe(first.sessionId);
      expect(second.title).toBe("first");
      expect(storage.sessions.list()).toHaveLength(1);
    } finally {
      storage.close();
    }
  });
});
