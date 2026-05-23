import type { DatabaseSync } from "node:sqlite";

import type { RuntimeOutputEvent, RuntimeOutputRepository } from "../../types/index.js";

import { parseJsonValue, serializeJsonValue } from "./json.js";

interface RuntimeOutputRow {
  event_id: string;
  event_type: RuntimeOutputEvent["eventType"];
  payload_json: string;
  sequence: number;
  stage: RuntimeOutputEvent["stage"];
  task_id: string;
  thread_id: string | null;
  timestamp: string;
}

export class SqliteRuntimeOutputRepository implements RuntimeOutputRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public append(event: Omit<RuntimeOutputEvent, "sequence">): RuntimeOutputEvent {
    this.database
      .prepare(
        `
          INSERT INTO output_events (
            event_id,
            task_id,
            thread_id,
            timestamp,
            event_type,
            stage,
            payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        event.eventId,
        event.taskId,
        event.threadId,
        event.timestamp,
        event.eventType,
        event.stage,
        serializeJsonValue(event.payload)
      );

    const row = this.database
      .prepare("SELECT * FROM output_events WHERE event_id = ?")
      .get(event.eventId) as RuntimeOutputRow | undefined;
    if (row === undefined) {
      throw new Error(`Runtime output event ${event.eventId} was not persisted.`);
    }
    return this.mapRow(row);
  }

  public listByTaskId(taskId: string): RuntimeOutputEvent[] {
    return this.list("task_id", taskId);
  }

  public listByThreadId(threadId: string): RuntimeOutputEvent[] {
    return this.list("thread_id", threadId);
  }

  private list(column: "task_id" | "thread_id", value: string): RuntimeOutputEvent[] {
    const rows = this.database
      .prepare(`SELECT * FROM output_events WHERE ${column} = ? ORDER BY sequence ASC`)
      .all(value) as unknown as RuntimeOutputRow[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: RuntimeOutputRow): RuntimeOutputEvent {
    return {
      eventId: row.event_id,
      eventType: row.event_type,
      payload: parseJsonValue<RuntimeOutputEvent["payload"]>(row.payload_json),
      sequence: row.sequence,
      stage: row.stage,
      taskId: row.task_id,
      threadId: row.thread_id,
      timestamp: row.timestamp
    } as RuntimeOutputEvent;
  }
}
