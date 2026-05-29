import type { RuntimeOutputEvent } from "../../types/index.js";

export type TranscriptViewerMode = "final" | "detail";

export interface TranscriptRow {
  eventId: string;
  kind: "assistant" | "input" | "status";
  sequence: number;
  text: string;
  timestamp: string;
}

export function buildTranscriptRows(
  events: RuntimeOutputEvent[],
  options: { mode: TranscriptViewerMode; query?: string }
): TranscriptRow[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  return events
    .flatMap((event) => toRows(event, options.mode))
    .filter((row) => query.length === 0 || row.text.toLowerCase().includes(query));
}

export function outputEventsToMarkdown(events: RuntimeOutputEvent[]): string {
  return buildTranscriptRows(events, { mode: "detail" })
    .map((row) => {
      const prefix = row.kind === "assistant" ? "Assistant" : row.kind === "input" ? "User" : "Activity";
      return `## ${prefix} #${row.sequence}\n\n${row.text}\n`;
    })
    .join("\n");
}

function toRows(event: RuntimeOutputEvent, mode: TranscriptViewerMode): TranscriptRow[] {
  switch (event.eventType) {
    case "task_input":
      return [row(event, "input", event.payload.input)];
    case "assistant_turn_completed":
      if (event.payload.display === "intermediate" && mode === "final") {
        return [];
      }
      return event.payload.text.trim().length === 0
        ? []
        : [row(event, "assistant", event.payload.text)];
    case "tool_status":
      if (mode !== "detail") {
        return [];
      }
      return event.payload.status === "failed"
        ? [row(event, "status", event.payload.summary)]
        : [row(event, "status", `${event.payload.status} ${event.payload.toolName}: ${event.payload.summary}`)];
    case "provider_status":
      return mode === "detail"
        ? [row(event, "status", `${event.payload.providerName}: ${event.payload.message}`)]
        : [];
    case "approval":
      return mode === "detail"
        ? [row(event, "status", `approval ${event.payload.status}: ${event.payload.toolName}`)]
        : [];
    case "clarification":
      return mode === "detail"
        ? [row(event, "status", `clarification ${event.payload.status}: ${event.payload.question ?? event.payload.promptId}`)]
        : [];
    case "result":
      return mode === "detail" && event.payload.output === null
        ? [row(event, "status", `task ${event.payload.status}`)]
        : [];
    case "error":
      return [row(event, "status", `${event.payload.status}: ${event.payload.message}`)];
    default:
      return [];
  }
}

function row(
  event: RuntimeOutputEvent,
  kind: TranscriptRow["kind"],
  text: string
): TranscriptRow {
  return {
    eventId: event.eventId,
    kind,
    sequence: event.sequence,
    text,
    timestamp: event.timestamp
  };
}
