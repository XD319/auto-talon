import type { JsonObject, ScheduleRecord } from "../../types/index.js";

export const SCHEDULE_EXECUTION_MODES = ["isolated", "continue", "session"] as const;

export type ScheduleExecutionMode = (typeof SCHEDULE_EXECUTION_MODES)[number];

export interface ResolvedScheduleExecution {
  executionMode: ScheduleExecutionMode;
  sessionId: string | null;
}

export function parseExecutionModeInput(
  value: string | null | undefined
): { executionMode: ScheduleExecutionMode; sessionId?: string } {
  if (value === undefined || value === null || value.trim().length === 0) {
    return { executionMode: "isolated" };
  }
  const normalized = value.trim();
  if (normalized === "isolated" || normalized === "continue") {
    return { executionMode: normalized };
  }
  if (normalized.startsWith("session:")) {
    const sessionId = normalized.slice("session:".length).trim();
    if (sessionId.length === 0) {
      throw new Error("session execution mode requires session:<id>.");
    }
    return { executionMode: "session", sessionId };
  }
  throw new Error(`Unsupported execution mode: ${value}`);
}

export function readScheduleExecutionMode(schedule: ScheduleRecord): ScheduleExecutionMode {
  const metadata = schedule.metadata.executionMode;
  if (metadata === "continue" || metadata === "session") {
    return metadata;
  }
  return "isolated";
}

export function resolveScheduleSessionId(schedule: ScheduleRecord): string | null {
  const mode = readScheduleExecutionMode(schedule);
  if (mode === "isolated") {
    return null;
  }
  return schedule.sessionId;
}

export function withExecutionModeMetadata(
  metadata: JsonObject,
  input: { executionMode?: ScheduleExecutionMode; sessionId?: string | null }
): JsonObject {
  const nextMetadata = { ...metadata };
  if (input.executionMode !== undefined) {
    nextMetadata.executionMode = input.executionMode;
  }
  return nextMetadata;
}

export function resolveCreateScheduleSessionId(input: {
  executionMode?: ScheduleExecutionMode;
  sessionId?: string | null;
  continuationSessionId?: string | null;
}): string | null {
  const mode = input.executionMode ?? "isolated";
  if (mode === "isolated") {
    return null;
  }
  if (mode === "continue") {
    return input.continuationSessionId ?? input.sessionId ?? null;
  }
  return input.sessionId ?? null;
}
