export interface ParsedNaturalLanguageSchedule {
  cron?: string;
  every?: string;
  runAt?: string;
}

export interface ParsedNaturalLanguageScheduleIntent {
  schedule: ParsedNaturalLanguageSchedule;
  taskInput: string;
  whenText: string;
}

const DATE_TIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s])(\d{1,2}):(\d{1,2})$/u;
const RELATIVE_DAY_TIME_RE = /^(今天|明天)\s*(.+)$/u;
const DAILY_TIME_RE = /^(每天|每日)\s*(.+)$/u;
const WEEKLY_TIME_RE = /^(每周|每星期)\s*$/u;
const RELATIVE_DURATION_RE = /^([0-9]+|[零〇一二两三四五六七八九十百]+)\s*(分钟|分|小时|天)\s*后$/u;
const RELATIVE_DURATION_PREFIX_RE =
  /^((?:[0-9]+|[零〇一二两三四五六七八九十百]+)\s*(?:分钟|分|小时|天)\s*后)\s*(.+)$/u;
const DAY_TIME_PREFIX_RE = /^((?:今天|明天)\s*(?:上午|早上|中午|下午|晚上)?\s*\d{1,2}(?::\d{1,2}|点\d{0,2})?分?)\s*(.+)$/u;
const DAILY_TIME_PREFIX_RE = /^((?:每天|每日)\s*(?:上午|早上|中午|下午|晚上)?\s*\d{1,2}(?::\d{1,2}|点\d{0,2})?分?)\s*(.+)$/u;
const SIMPLE_RECURRING_PREFIX_RE = /^((?:每小时|每天|每日|每周|每星期))\s*(.+)$/u;
const TIME_OF_DAY_RE = /^(?:(上午|早上|中午|下午|晚上)\s*)?(\d{1,2})(?::(\d{1,2})|点(\d{1,2})?)?分?$/u;

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  七: 7,
  三: 3,
  九: 9,
  二: 2,
  五: 5,
  八: 8,
  六: 6,
  〇: 0,
  两: 2,
  四: 4,
  零: 0
};

export function parseNaturalLanguageScheduleWhen(
  value: string,
  now = new Date()
): ParsedNaturalLanguageSchedule {
  const normalized = value.trim();
  if (normalized === "每小时") {
    return { every: "1h" };
  }
  if (normalized === "每天" || normalized === "每日") {
    return { every: "1d" };
  }
  if (normalized === "每周" || WEEKLY_TIME_RE.test(normalized)) {
    return { every: "7d" };
  }

  const durationMatch = RELATIVE_DURATION_RE.exec(normalized);
  if (durationMatch !== null) {
    const amount = parseChineseOrArabicInteger(durationMatch[1] ?? "");
    const unit = durationMatch[2] ?? "";
    if (amount <= 0) {
      throw new Error("Unsupported schedule phrase. Relative duration must be positive.");
    }
    return { runAt: new Date(now.getTime() + amount * durationUnitMs(unit)).toISOString() };
  }

  const dailyMatch = DAILY_TIME_RE.exec(normalized);
  if (dailyMatch !== null) {
    const time = parseTimeOfDay(dailyMatch[2] ?? "");
    return { cron: `${time.minute} ${time.hour} * * *` };
  }

  const relativeMatch = RELATIVE_DAY_TIME_RE.exec(normalized);
  if (relativeMatch !== null) {
    const [, dayLabel, timeText] = relativeMatch;
    const date = new Date(now);
    if (dayLabel === "明天") {
      date.setDate(date.getDate() + 1);
    }
    const time = parseTimeOfDay(timeText ?? "");
    return {
      runAt: buildLocalRunAtIso(date.getFullYear(), date.getMonth() + 1, date.getDate(), time.hour, time.minute)
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
    "Unsupported schedule phrase. Use 每小时, 每天, 每周, 1分钟后, 今天 HH:mm, 明天 HH:mm, 每天 HH:mm, or YYYY-MM-DD HH:mm."
  );
}

export function parseNaturalLanguageScheduleIntent(
  value: string,
  now = new Date()
): ParsedNaturalLanguageScheduleIntent | null {
  const normalized = value.trim();
  const match =
    RELATIVE_DURATION_PREFIX_RE.exec(normalized) ??
    DAILY_TIME_PREFIX_RE.exec(normalized) ??
    DAY_TIME_PREFIX_RE.exec(normalized) ??
    SIMPLE_RECURRING_PREFIX_RE.exec(normalized);

  if (match === null) {
    return null;
  }

  const whenText = match[1]?.trim() ?? "";
  const taskInput = stripPromptLeadIn(match[2]?.trim() ?? "");
  if (whenText.length === 0 || taskInput.length === 0) {
    return null;
  }

  return {
    schedule: parseNaturalLanguageScheduleWhen(whenText, now),
    taskInput,
    whenText
  };
}

function stripPromptLeadIn(value: string): string {
  return value
    .replace(/^(请|麻烦)?\s*(提醒我|帮我执行|帮我查看|帮我|执行|查看一下|查看|看一下|告诉我|给我)\s*/u, "")
    .trim();
}

function durationUnitMs(unit: string): number {
  switch (unit) {
    case "分钟":
    case "分":
      return 60_000;
    case "小时":
      return 60 * 60_000;
    case "天":
      return 24 * 60 * 60_000;
    default:
      throw new Error(`Unsupported schedule phrase. Unsupported relative unit: ${unit}`);
  }
}

function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const normalized = value.trim();
  const match = TIME_OF_DAY_RE.exec(normalized);
  if (match === null) {
    throw new Error("Unsupported schedule phrase. Date/time is invalid.");
  }

  const period = match[1] ?? "";
  let hour = Number.parseInt(match[2] ?? "0", 10);
  const minute = Number.parseInt(match[3] ?? match[4] ?? "0", 10);
  if (period === "下午" || period === "晚上") {
    if (hour >= 1 && hour <= 11) {
      hour += 12;
    }
  }
  if (period === "中午" && hour >= 1 && hour <= 10) {
    hour += 12;
  }

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Unsupported schedule phrase. Date/time is invalid.");
  }
  return { hour, minute };
}

function parseChineseOrArabicInteger(value: string): number {
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  if (normalized.length === 0) {
    return Number.NaN;
  }

  let total = 0;
  let section = 0;
  let current = 0;
  for (const char of normalized) {
    if (char === "百") {
      section += (current === 0 ? 1 : current) * 100;
      current = 0;
      continue;
    }
    if (char === "十") {
      section += (current === 0 ? 1 : current) * 10;
      current = 0;
      continue;
    }
    const digit = CHINESE_DIGITS[char];
    if (digit === undefined) {
      return Number.NaN;
    }
    current = digit;
  }
  total += section + current;
  return total;
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
