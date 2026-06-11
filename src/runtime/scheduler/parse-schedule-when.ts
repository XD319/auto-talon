import { parseEveryExpression } from "./next-fire.js";

export interface ParsedScheduleWhen {
  cron?: string;
  every?: string;
  runAt?: string;
}

const RELATIVE_AT_RE = /^(\d+)\s*(ms|s|m|h|d)$/i;
const EVERY_PREFIX_RE = /^every\s+(\d+\s*(?:ms|s|m|h|d))$/i;
const CRON_RE = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+(\S+))?$/u;
const ISO_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;

export function parseScheduleWhen(value: string, now = new Date()): ParsedScheduleWhen {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("Schedule when expression cannot be empty.");
  }

  const everyMatch = EVERY_PREFIX_RE.exec(normalized);
  if (everyMatch !== null) {
    const every = everyMatch[1]?.trim() ?? "";
    parseEveryExpression(every);
    return { every };
  }

  const relativeMatch = RELATIVE_AT_RE.exec(normalized);
  if (relativeMatch !== null) {
    const amountPart = relativeMatch[1];
    const unitPart = relativeMatch[2];
    if (amountPart === undefined || unitPart === undefined) {
      throw new Error(`Invalid relative schedule expression: ${value}`);
    }
    const amount = Number.parseInt(amountPart, 10);
    const unit = unitPart.toLowerCase();
    const multiplier = unitMultiplier(unit);
    if (!Number.isFinite(amount) || amount <= 0 || multiplier === null) {
      throw new Error(`Invalid relative schedule expression: ${value}`);
    }
    return { runAt: new Date(now.getTime() + amount * multiplier).toISOString() };
  }

  if (CRON_RE.test(normalized)) {
    return { cron: normalized };
  }

  if (ISO_RE.test(normalized)) {
    return { runAt: new Date(normalized).toISOString() };
  }

  throw new Error(
    `Unsupported schedule when expression: ${value}. Use 30m, every 2h, cron, or ISO timestamps.`
  );
}

function unitMultiplier(unit: string): number | null {
  switch (unit) {
    case "ms":
      return 1;
    case "s":
      return 1_000;
    case "m":
      return 60_000;
    case "h":
      return 3_600_000;
    case "d":
      return 86_400_000;
    default:
      return null;
  }
}
