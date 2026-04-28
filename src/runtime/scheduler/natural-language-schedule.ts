export interface ParsedNaturalLanguageSchedule {
  every?: string;
  runAt?: string;
}

const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s])(\d{2}):(\d{2})$/u;
const RELATIVE_DAY_TIME_RE = /^(今天|明天)\s+(\d{2}):(\d{2})$/u;

export function parseNaturalLanguageScheduleWhen(
  value: string,
  now = new Date()
): ParsedNaturalLanguageSchedule {
  const normalized = value.trim();
  if (normalized === "每小时") {
    return { every: "1h" };
  }
  if (normalized === "每天") {
    return { every: "1d" };
  }
  if (normalized === "每周") {
    return { every: "7d" };
  }

  const relativeMatch = RELATIVE_DAY_TIME_RE.exec(normalized);
  if (relativeMatch !== null) {
    const [, dayLabel, hourText, minuteText] = relativeMatch;
    const date = new Date(now);
    if (dayLabel === "明天") {
      date.setDate(date.getDate() + 1);
    }
    return {
      runAt: buildLocalRunAtIso(
        date.getFullYear(),
        date.getMonth() + 1,
        date.getDate(),
        Number.parseInt(hourText ?? "0", 10),
        Number.parseInt(minuteText ?? "0", 10)
      )
    };
  }

  const absoluteMatch = DATE_TIME_RE.exec(normalized);
  if (absoluteMatch !== null) {
    const [, yearText, monthText, dayText, hourText, minuteText] = absoluteMatch;
    return {
      runAt: buildLocalRunAtIso(
        Number.parseInt(yearText ?? "0", 10),
        Number.parseInt(monthText ?? "0", 10),
        Number.parseInt(dayText ?? "0", 10),
        Number.parseInt(hourText ?? "0", 10),
        Number.parseInt(minuteText ?? "0", 10)
      )
    };
  }

  throw new Error(
    "Unsupported schedule phrase. Use 每小时, 每天, 每周, 今天 HH:mm, 明天 HH:mm, or YYYY-MM-DD HH:mm."
  );
}

function buildLocalRunAtIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): string {
  if (!isValidCalendarDate(year, month, day) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Unsupported schedule phrase. Date/time is invalid.");
  }
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    local.getFullYear() !== year ||
    local.getMonth() !== month - 1 ||
    local.getDate() !== day ||
    local.getHours() !== hour ||
    local.getMinutes() !== minute
  ) {
    throw new Error("Unsupported schedule phrase. Date/time is invalid.");
  }
  return local.toISOString();
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(year, month - 1, day);
  return (
    probe.getFullYear() === year &&
    probe.getMonth() === month - 1 &&
    probe.getDate() === day
  );
}
