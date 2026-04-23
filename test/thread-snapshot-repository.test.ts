import { describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";

describe("thread snapshot repository", () => {
  it("creates and queries snapshots by id and thread", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.threads.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        threadId: "thread-1",
        title: "snapshot thread"
      });

      const first = storage.threadSnapshots.create({
        activeMemoryIds: ["m1"],
        goal: "Initial objective",
        nextActions: ["do A"],
        openLoops: ["pending shell call"],
        snapshotId: "snap-1",
        summary: "first summary",
        threadId: "thread-1",
        toolCapabilitySummary: ["Shell"],
        trigger: "compact"
      });
      const second = storage.threadSnapshots.create({
        activeMemoryIds: ["m2"],
        goal: "Updated objective",
        nextActions: ["do B"],
        openLoops: [],
        snapshotId: "snap-2",
        summary: "second summary",
        threadId: "thread-1",
        toolCapabilitySummary: ["ReadFile"],
        trigger: "manual"
      });

      expect(storage.threadSnapshots.findById(first.snapshotId)?.goal).toBe("Initial objective");
      expect(storage.threadSnapshots.findLatestByThread("thread-1")?.snapshotId).toBe("snap-2");
      expect(storage.threadSnapshots.listByThread("thread-1").map((item) => item.snapshotId)).toEqual([
        "snap-2",
        "snap-1"
      ]);
      expect(second.trigger).toBe("manual");
    } finally {
      storage.close();
    }
  });
});
