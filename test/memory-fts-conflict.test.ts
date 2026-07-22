import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { writeMemoryEnabled } from "../src/runtime/runtime-config.js";
import { SqliteFtsMemorySearchProvider } from "../src/memory/sqlite-fts-memory-search-provider.js";
import { StorageManager } from "../src/storage/database.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) {
      rmSync(path, { force: true, recursive: true });
    }
  }
});

describe("memory FTS and conflict resolution", () => {
  it("indexes verified memories in SQLite FTS and returns curated search hits", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const provider = new SqliteFtsMemorySearchProvider(storage.database, (id) =>
        storage.memories.findById(id)
      );
      const memory = storage.memories.create({
        scope: "project",
        scopeKey: "/repo",
        title: "Use vitest",
        summary: "Prefer vitest for tests",
        content: "Prefer vitest for unit and integration tests.",
        source: {
          sourceType: "manual_review",
          taskId: null,
          toolCallId: null,
          traceEventId: null,
          label: "test"
        },
        privacyLevel: "internal",
        retentionPolicy: { kind: "project", ttlDays: null, reason: "test" },
        confidence: 0.95,
        status: "verified",
        tier: "retrieval",
        expiresAt: null,
        keywords: ["vitest", "tests"]
      });
      provider.upsertSync(memory);
      expect(provider.coverage()).toBeGreaterThan(0);
      const hits = provider.searchSync("vitest", 5);
      expect(hits[0]?.memory.memoryId).toBe(memory.memoryId);
    } finally {
      storage.close();
    }
  });

  it("resolves conflicts by keeping one memory and archiving the other", () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-mem-conflict-"));
    tempPaths.push(dir);
    writeMemoryEnabled(dir, true);
    const handle = createApplication(dir);
    try {
      const first = handle.service.addMemory({
        content: "Runtime uses pnpm for package management in this workspace.",
        cwd: dir,
        profileId: "executor",
        reviewerId: "tester",
        scope: "project",
        userId: "u1"
      });
      const second = handle.service.addMemory({
        content: "Runtime uses npm for package management in this workspace.",
        cwd: dir,
        profileId: "executor",
        reviewerId: "tester",
        scope: "project",
        userId: "u1"
      });
      expect(first.conflictsWith.length + second.conflictsWith.length).toBeGreaterThan(0);
      const resolved = handle.service.resolveMemoryConflict({
        archiveMemoryId: second.memoryId,
        keepMemoryId: first.memoryId,
        reviewerId: "tester"
      });
      expect(resolved.kept.status).toBe("verified");
      expect(resolved.archived.status).toBe("archived");
      expect(resolved.kept.conflictsWith).not.toContain(second.memoryId);
    } finally {
      handle.close();
    }
  });
});
