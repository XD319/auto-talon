import { computeNextFireAt, parseEveryExpression } from "./next-fire.js";
import { parseScheduleWhen } from "./parse-schedule-when.js";

export type ScheduleTiming =
  | { kind: "cron"; cron: string; timezone: string | null }
  | { kind: "every"; every: string; intervalMs: number }
  | { kind: "runAt"; runAt: string };

export interface ScheduleTimingInput {
  at?: string | undefined;
  cron?: string | null | undefined;
  every?: string | null | undefined;
  timezone?: string | null | undefined;
  when?: string | undefined;
}

export interface ScheduleTimingPreview {
  kind: ScheduleTiming["kind"];
  nextFireAt: string | null;
  nextFirePreview: string[];
  normalized: {
    cron: string | null;
    every: string | null;
    intervalMs: number | null;
    runAt: string | null;
    timezone: string | null;
  };
}

export function resolveScheduleTiming(input: ScheduleTimingInput): ScheduleTiming {
  const explicit = [
    input.at !== undefined ? "at" : null,
    input.cron !== undefined && input.cron !== null ? "cron" : null,
    input.every !== undefined && input.every !== null ? "every" : null
  ].filter((entry): entry is "at" | "cron" | "every" => entry !== null);

  if (input.when !== undefined) {
    if (explicit.length > 0) {
      throw new Error("Schedule timing cannot combine `when` with explicit at, cron, or every fields.");
    }
    const parsed = parseScheduleWhen(input.when);
    return resolveScheduleTiming({
      at: parsed.runAt,
      cron: parsed.cron,
      every: parsed.every,
      timezone: input.timezone
    });
  }

  if (explicit.length !== 1) {
    throw new Error("Schedule timing must define exactly one of at, every, or cron.");
  }

  if (input.at !== undefined) {
    const parsed = parseScheduleWhen(input.at);
    if (parsed.runAt === undefined) {
      throw new Error(`Schedule at expression must resolve to a one-shot time, got: ${input.at}`);
    }
    return { kind: "runAt", runAt: parsed.runAt };
  }

  if (input.every !== undefined && input.every !== null) {
    return {
      every: input.every,
      intervalMs: parseEveryExpression(input.every),
      kind: "every"
    };
  }

  const cron = input.cron;
  if (cron === undefined || cron === null || cron.trim().length === 0) {
    throw new Error("Schedule cron expression cannot be empty.");
  }
  const timing: ScheduleTiming = {
    cron: cron.trim(),
    kind: "cron",
    timezone: input.timezone ?? null
  };
  previewScheduleTiming(timing, 1);
  return timing;
}

export function timingToCreateFields(timing: ScheduleTiming): {
  cron?: string;
  every?: string;
  runAt?: string;
  timezone?: string;
} {
  if (timing.kind === "cron") {
    return {
      cron: timing.cron,
      ...(timing.timezone !== null ? { timezone: timing.timezone } : {})
    };
  }
  if (timing.kind === "every") {
    return { every: timing.every };
  }
  return { runAt: timing.runAt };
}

export function previewScheduleTiming(
  timing: ScheduleTiming,
  count = 5,
  from = new Date()
): ScheduleTimingPreview {
  const safeCount = Math.max(1, Math.min(count, 20));
  const preview: string[] = [];
  let cursor = from;
  for (let index = 0; index < safeCount; index += 1) {
    const next = computeNextFireAt(
      {
        cron: timing.kind === "cron" ? timing.cron : null,
        intervalMs: timing.kind === "every" ? timing.intervalMs : null,
        timezone: timing.kind === "cron" ? timing.timezone : null
      },
      cursor
    );
    if (next === null) {
      if (timing.kind === "runAt" && preview.length === 0) {
        preview.push(timing.runAt);
      }
      break;
    }
    preview.push(next.toISOString());
    cursor = next;
  }

  return {
    kind: timing.kind,
    nextFireAt: preview[0] ?? null,
    nextFirePreview: preview,
    normalized: {
      cron: timing.kind === "cron" ? timing.cron : null,
      every: timing.kind === "every" ? timing.every : null,
      intervalMs: timing.kind === "every" ? timing.intervalMs : null,
      runAt: timing.kind === "runAt" ? timing.runAt : null,
      timezone: timing.kind === "cron" ? timing.timezone : null
    }
  };
}

export function formatScheduleTimingPreview(preview: ScheduleTimingPreview): string {
  return [
    `Timing: ${preview.kind}`,
    `Cron: ${preview.normalized.cron ?? "-"}`,
    `Every: ${preview.normalized.every ?? "-"}`,
    `Run At: ${preview.normalized.runAt ?? "-"}`,
    `Timezone: ${preview.normalized.timezone ?? "-"}`,
    `Next Fire: ${preview.nextFireAt ?? "-"}`,
    `Preview: ${preview.nextFirePreview.length > 0 ? preview.nextFirePreview.join(", ") : "-"}`
  ].join("\n");
}
