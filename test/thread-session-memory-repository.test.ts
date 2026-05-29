import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/storage/migrations.js";
import { StorageManager } from "../src/storage/database.js";
import { ThreadSessionMemoryService } from "../src/runtime/context/thread-session-memory-service.js";
import type { TraceService } from "../src/tracing/trace-service.js";
import type { TraceEvent, TraceEventDraft } from "../src/types/index.js";

describe("thread session memory repository", () => {
  it("emits compact trace metadata from persisted session memory", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const trace: TraceEvent[] = [];
    try {
      storage.threads.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        threadId: "thread-memory-trace",
        title: "thread memory trace"
      });
      const service = new ThreadSessionMemoryService({
        repository: storage.threadSessionMemories,
        traceService: {
          record(event: TraceEventDraft) {
            const persisted = {
              ...event,
              eventId: event.eventId ?? `trace-${trace.length}`,
              sequence: trace.length + 1,
              timestamp: event.timestamp ?? "2026-01-01T00:00:00.000Z"
            } as TraceEvent;
            trace.push(persisted);
            return persisted;
          }
        } as unknown as TraceService
      });

      service.create({
        decisions: [],
        goal: "Ship feature",
        metadata: {
          compactReason: "tool_call_count",
          replacedMessageCount: 17
        },
        nextActions: [],
        openLoops: [],
        summary: "compact memory",
        taskId: "task-compact",
        threadId: "thread-memory-trace",
        trigger: "compact"
      });

      const compacted = trace.find((event) => event.eventType === "session_compacted");
      expect(compacted?.payload).toMatchObject({
        reason: "tool_call_count",
        replacedMessageCount: 17
      });
    } finally {
      storage.close();
    }
  });

  it("writes events, upserts current, and keeps history order", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.threads.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        threadId: "thread-memory-1",
        title: "thread memory"
      });

      const first = storage.threadSessionMemories.create({
        decisions: ["choose plan A"],
        goal: "Ship feature",
        nextActions: ["implement api"],
        openLoops: ["pending benchmark"],
        summary: "first memory",
        taskId: "task-1",
        threadId: "thread-memory-1",
        trigger: "manual"
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 1);
      });
      const second = storage.threadSessionMemories.create({
        decisions: ["switch to plan B"],
        goal: "Ship feature",
        nextActions: ["update docs"],
        openLoops: [],
        summary: "second memory",
        taskId: "task-2",
        threadId: "thread-memory-1",
        trigger: "final"
      });

      const latest = storage.threadSessionMemories.findLatestByThread("thread-memory-1");
      const history = storage.threadSessionMemories.listByThread("thread-memory-1");
      const currentRows = storage.database
        .prepare("SELECT thread_id, session_memory_id FROM thread_session_memories_current")
        .all() as Array<{ session_memory_id: string; thread_id: string }>;
      const eventRows = storage.database
        .prepare("SELECT session_memory_id FROM thread_session_memory_events WHERE thread_id = ?")
        .all("thread-memory-1") as Array<{ session_memory_id: string }>;

      expect(latest?.sessionMemoryId).toBe(second.sessionMemoryId);
      expect(latest?.trigger).toBe("final");
      expect(history.map((item) => item.sessionMemoryId)).toEqual([second.sessionMemoryId, first.sessionMemoryId]);
      expect(currentRows).toEqual([
        {
          session_memory_id: second.sessionMemoryId,
          thread_id: "thread-memory-1"
        }
      ]);
      expect(eventRows).toHaveLength(2);
    } finally {
      storage.close();
    }
  });

  it("backfills events and current from legacy thread_session_memory data", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE threads (
          thread_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          owner_user_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          agent_profile_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          archived_at TEXT,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE thread_session_memory (
          session_memory_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          run_id TEXT,
          task_id TEXT,
          trigger TEXT NOT NULL,
          summary TEXT NOT NULL,
          goal TEXT NOT NULL,
          decisions_json TEXT NOT NULL,
          open_loops_json TEXT NOT NULL,
          next_actions_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE session_index (
          session_memory_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          summary TEXT NOT NULL,
          goal TEXT NOT NULL,
          decisions TEXT NOT NULL,
          open_loops TEXT NOT NULL,
          next_actions TEXT NOT NULL,
          keywords TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      database.exec("PRAGMA user_version = 9");

      database
        .prepare(
          `INSERT INTO threads (
            thread_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name, created_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("thread-a", "A", "active", "u1", "/tmp", "executor", "mock", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "{}");
      database
        .prepare(
          `INSERT INTO threads (
            thread_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name, created_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("thread-b", "B", "active", "u1", "/tmp", "executor", "mock", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "{}");

      const insertLegacy = database.prepare(
        `INSERT INTO thread_session_memory (
          session_memory_id, thread_id, run_id, task_id, trigger, summary, goal,
          decisions_json, open_loops_json, next_actions_json, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertLegacy.run(
        "legacy-1",
        "thread-a",
        null,
        "task-1",
        "manual",
        "legacy first",
        "goal",
        "[]",
        "[]",
        "[]",
        "2026-01-01T00:00:00.000Z",
        "{}"
      );
      insertLegacy.run(
        "legacy-2",
        "thread-a",
        null,
        "task-2",
        "final",
        "legacy second",
        "goal",
        "[]",
        "[]",
        "[]",
        "2026-01-02T00:00:00.000Z",
        "{}"
      );
      insertLegacy.run(
        "legacy-3",
        "thread-b",
        null,
        "task-3",
        "manual",
        "legacy other thread",
        "goal",
        "[]",
        "[]",
        "[]",
        "2026-01-03T00:00:00.000Z",
        "{}"
      );

      runMigrations(database);

      const eventCount = database
        .prepare("SELECT COUNT(*) AS count FROM thread_session_memory_events")
        .get() as { count: number };
      const currentCount = database
        .prepare("SELECT COUNT(*) AS count FROM thread_session_memories_current")
        .get() as { count: number };
      const currentForThreadA = database
        .prepare("SELECT session_memory_id FROM thread_session_memories_current WHERE thread_id = ?")
        .get("thread-a") as { session_memory_id: string };

      expect(eventCount.count).toBe(3);
      expect(currentCount.count).toBe(2);
      expect(currentForThreadA.session_memory_id).toBe("legacy-2");
    } finally {
      database.close();
    }
  });
});
