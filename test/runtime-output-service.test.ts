import { describe, expect, it } from "vitest";

import { RuntimeOutputService } from "../src/runtime/runtime-output-service.js";
import type { RuntimeOutputRepository, TaskRecord, TraceEvent } from "../src/types/index.js";

describe("RuntimeOutputService", () => {
  it("projects fileChange onto tool_status finished events", () => {
    const repository = createRepository();
    const service = new RuntimeOutputService(repository, () => null);
    const traceEvent: TraceEvent = {
      actor: "tool",
      eventId: "event-1",
      eventType: "tool_call_finished",
      payload: {
        fileChange: {
          addedLineCount: 2,
          changedLineCount: 2,
          path: "src/app.ts",
          removedLineCount: 0,
          unifiedDiffPreview: "-old\n+new"
        },
        iteration: 1,
        outputPreview: "",
        summary: "Wrote src/app.ts (+2 -0)",
        toolCallId: "tool-1",
        toolName: "write_file"
      },
      sequence: 1,
      stage: "tooling",
      summary: "Tool write_file finished",
      taskId: "task-1",
      timestamp: "2026-06-10T00:00:00.000Z"
    };

    service.projectTrace(traceEvent);
    const recorded = repository.events[0];

    expect(recorded?.eventType).toBe("tool_status");
    if (recorded?.eventType === "tool_status") {
      expect(recorded.payload.status).toBe("finished");
      expect(recorded.payload.fileChange).toEqual(traceEvent.payload.fileChange);
    }
  });
});

function createRepository(): RuntimeOutputRepository & { events: ReturnType<RuntimeOutputRepository["append"]>[] } {
  const events: ReturnType<RuntimeOutputRepository["append"]>[] = [];
  return {
    events,
    append(record) {
      const persisted = {
        ...record,
        sequence: events.length + 1
      };
      events.push(persisted);
      return persisted;
    },
    listBySessionId: () => events,
    listByTaskId: () => events
  };
}
