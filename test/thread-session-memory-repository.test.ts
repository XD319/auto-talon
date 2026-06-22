import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/storage/migrations.js";
import { StorageManager } from "../src/storage/database.js";
import { SessionSummaryService } from "../src/runtime/context/session-summary-service.js";
import type { TraceService } from "../src/tracing/trace-service.js";
import type { TraceEvent, TraceEventDraft } from "../src/types/index.js";

describe("session session memory repository", () => {
  it("emits compact trace metadata from persisted session memory", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    const trace: TraceEvent[] = [];
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-memory-trace",
        title: "session memory trace"
      });
      const service = new SessionSummaryService({
        repository: storage.sessionSummaries,
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
        sessionId: "session-memory-trace",
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

  it("writes events, upserts current, and keeps history order", () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      storage.sessions.create({
        agentProfileId: "executor",
        cwd: "/tmp/workspace",
        ownerUserId: "u1",
        providerName: "mock",
        sessionId: "session-memory-1",
        title: "session memory"
      });

      const first = storage.sessionSummaries.create({
        decisions: ["choose plan A"],
        goal: "Ship feature",
        nextActions: ["implement api"],
        openLoops: ["pending benchmark"],
        summary: "first memory",
        taskId: "task-1",
        sessionId: "session-memory-1",
        trigger: "manual"
      });
      const second = storage.sessionSummaries.create({
        decisions: ["switch to plan B"],
        goal: "Ship feature",
        nextActions: ["update docs"],
        openLoops: [],
        summary: "second memory",
        taskId: "task-2",
        sessionId: "session-memory-1",
        trigger: "final"
      });

      const latest = storage.sessionSummaries.findLatestBySession("session-memory-1");
      const history = storage.sessionSummaries.listBySession("session-memory-1");
      const currentRows = storage.database
        .prepare("SELECT session_id, session_memory_id FROM session_summaries_current")
        .all() as Array<{ session_memory_id: string; session_id: string }>;
      const eventRows = storage.database
        .prepare("SELECT session_memory_id FROM session_summary_events WHERE session_id = ?")
        .all("session-memory-1") as Array<{ session_memory_id: string }>;

      expect(latest?.sessionSummaryId).toBe(second.sessionSummaryId);
      expect(latest?.trigger).toBe("final");
      expect(history.map((item) => item.sessionSummaryId)).toEqual([second.sessionSummaryId, first.sessionSummaryId]);
      expect(currentRows).toEqual([
        {
          session_memory_id: second.sessionSummaryId,
          session_id: "session-memory-1"
        }
      ]);
      expect(eventRows).toHaveLength(2);
    } finally {
      storage.close();
    }
  });

  it("backfills events and current from legacy session_summary data", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE sessions (
          session_id TEXT PRIMARY KEY,
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
        CREATE TABLE session_summary (
          session_memory_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
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
          session_id TEXT NOT NULL,
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
          `INSERT INTO sessions (
            session_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name, created_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("session-a", "A", "active", "u1", "/tmp", "executor", "mock", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "{}");
      database
        .prepare(
          `INSERT INTO sessions (
            session_id, title, status, owner_user_id, cwd, agent_profile_id, provider_name, created_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("session-b", "B", "active", "u1", "/tmp", "executor", "mock", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "{}");

      const insertLegacy = database.prepare(
        `INSERT INTO session_summary (
          session_memory_id, session_id, run_id, task_id, trigger, summary, goal,
          decisions_json, open_loops_json, next_actions_json, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insertLegacy.run(
        "legacy-1",
        "session-a",
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
        "session-a",
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
        "session-b",
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
        .prepare("SELECT COUNT(*) AS count FROM session_summary_events")
        .get() as { count: number };
      const currentCount = database
        .prepare("SELECT COUNT(*) AS count FROM session_summaries_current")
        .get() as { count: number };
      const currentForThreadA = database
        .prepare("SELECT session_memory_id FROM session_summaries_current WHERE session_id = ?")
        .get("session-a") as { session_memory_id: string };

      expect(eventCount.count).toBe(3);
      expect(currentCount.count).toBe(2);
      expect(currentForThreadA.session_memory_id).toBe("legacy-2");
    } finally {
      database.close();
    }
  });
});
