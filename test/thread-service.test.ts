import { describe, expect, it } from "vitest";

import { ThreadService } from "../src/runtime/threads/index.js";
import { StorageManager } from "../src/storage/database.js";

describe("thread service", () => {
  it("creates and archives threads with lineage", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const service = new ThreadService({
        threadLineageRepository: storage.threadLineage,
        threadRepository: storage.threads,
        threadRunRepository: storage.threadRuns
      });

      const thread = service.getOrCreateThread({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u2",
        providerName: "mock",
        title: "service thread"
      });
      expect(service.listThreads()).toHaveLength(1);

      const archived = service.archiveThread(thread.threadId);
      expect(archived.status).toBe("archived");
      expect(storage.threadLineage.listByThreadId(thread.threadId).at(-1)?.eventType).toBe("archive");
    } finally {
      storage.close();
    }
  });
});
