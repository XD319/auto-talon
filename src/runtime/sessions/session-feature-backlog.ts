import type { JsonObject } from "../../types/index.js";
import type { TodoItem } from "../../tools/todo-session-store.js";

export type FeatureBacklogStatus = "pending" | "done" | "skipped";
export type FeatureBacklogSource = "agent" | "user" | "clarify";

export const MAX_FEATURE_BACKLOG_ITEMS = 15;
export const MIN_RESUME_BACKLOG_ITEMS = 2;
export const MAX_RESUME_DONE_ITEMS = 5;
export const MAX_RESUME_PENDING_ITEMS = 10;

export interface FeatureBacklogItem {
  name: string;
  source: FeatureBacklogSource;
  status: FeatureBacklogStatus;
}

export interface FeatureBacklogCollectionResult {
  droppedCount: number;
  filteredCount: number;
  items: FeatureBacklogItem[];
  rawCount: number;
}

const HEADER_CELL_PATTERN =
  /^(功能|feature|name|任务|task|状态|status|详情|文件|指标|优先级|复杂度|说明|清理前|清理后)$/iu;
const SKIP_TABLE_HEADER_PATTERN = /文件|指标|清理前|清理后/iu;
const NAME_COLUMN_HEADER_PATTERN = /功能|feature|name|任务|task/iu;
const STATUS_COLUMN_HEADER_PATTERN = /状态|status/iu;
const ACTION_VERB_PATTERN =
  /删除|添加|实现|完成|更新|修复|集成|重构|优化|验证|创建|移除|迁移|拆分|合并|引入|支持/iu;
const CODE_PATTERN = /this\.|function\s|=\s*options\.|import\s|const\s|let\s|var\s/iu;
const LEGEND_PATTERN = /^[🔴🟡🟢⬜✅❌\s]+$/u;
const PRIORITY_LEGEND_PATTERN = /^[🔴🟡🟢]\s*[高中低]$/u;
const SUGGESTION_SECTION_PATTERN = /^(?:#{1,3}\s*)?(?:下一步建议|建议|后续|待办)/iu;
const SUGGESTION_BULLET_PATTERN =
  /^(?:\d+\.\s+)(?:\*\*)?(.+?)(?:\*\*)?(?:\s*[-–—]\s*.+)?$/u;

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export function parseFeatureBacklogFromMetadata(metadata: JsonObject | undefined): FeatureBacklogItem[] {
  if (metadata === undefined) {
    return [];
  }
  const raw = metadata.featureBacklog;
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: FeatureBacklogItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name.length === 0) {
      continue;
    }
    const status = normalizeStatus(record.status);
    const source = normalizeSource(record.source);
    items.push({ name, source, status });
  }
  return items;
}

export function extractFeatureBacklogFromText(
  text: string,
  source: FeatureBacklogSource = "agent"
): FeatureBacklogItem[] {
  const cleaned = stripFencedCodeBlocks(text);
  const items: FeatureBacklogItem[] = [];
  const seen = new Set<string>();

  for (const table of parseMarkdownTables(cleaned)) {
    for (const item of extractFromTable(table, source)) {
      if (seen.has(item.name)) {
        continue;
      }
      seen.add(item.name);
      items.push(item);
    }
  }

  for (const item of extractFromSuggestionBullets(cleaned, source)) {
    if (seen.has(item.name)) {
      continue;
    }
    seen.add(item.name);
    items.push(item);
  }

  return capFeatureBacklog(items);
}

export function fromTodoItems(todos: TodoItem[]): FeatureBacklogItem[] {
  return todos
    .filter((todo) => todo.status !== "cancelled")
    .map((todo) => ({
      name: todo.content.trim(),
      source: "agent" as const,
      status: todo.status === "completed" ? ("done" as const) : ("pending" as const)
    }))
    .filter((item) => item.name.length > 0);
}

export function extractFeatureBacklogFromDecisions(decisions: string[]): FeatureBacklogItem[] {
  const items: FeatureBacklogItem[] = [];
  const seen = new Set<string>();
  for (const decision of decisions) {
    const match = decision.match(/^Clarify:\s*(.+)$/iu);
    if (match?.[1] === undefined) {
      continue;
    }
    const name = normalizeFeatureName(match[1]);
    if (name.length === 0 || seen.has(name)) {
      continue;
    }
    seen.add(name);
    items.push({ name, source: "clarify", status: "pending" });
  }
  return items;
}

export function collectFeatureBacklog(input: {
  assistantMessages: string[];
  decisions?: string[];
  previousMetadata?: JsonObject;
  sessionTodos?: TodoItem[];
}): FeatureBacklogCollectionResult {
  const previous = parseFeatureBacklogFromMetadata(input.previousMetadata);
  const fromClarify = extractFeatureBacklogFromDecisions(input.decisions ?? []);
  const fromTodos = fromTodoItems(input.sessionTodos ?? []);
  const fromText = input.assistantMessages.flatMap((message) => extractFeatureBacklogFromText(message));
  const rawMerged = mergeFeatureBacklog(previous, [...fromClarify, ...fromTodos, ...fromText]);
  const rawCount = rawMerged.length;
  const filtered = capFeatureBacklog(
    rawMerged.filter(
      (item) => item.source === "clarify" || item.source === "user" || isLikelyFeatureName(item.name)
    )
  );
  return {
    droppedCount: Math.max(0, rawCount - filtered.length),
    filteredCount: filtered.length,
    items: filtered,
    rawCount
  };
}

export function mergeFeatureBacklog(
  previous: FeatureBacklogItem[],
  incoming: FeatureBacklogItem[]
): FeatureBacklogItem[] {
  const byName = new Map<string, FeatureBacklogItem>();
  for (const item of previous) {
    byName.set(item.name, item);
  }
  for (const item of incoming) {
    const existing = byName.get(item.name);
    if (existing === undefined) {
      byName.set(item.name, item);
      continue;
    }
    byName.set(item.name, {
      name: item.name,
      source: existing.source === "clarify" ? existing.source : item.source,
      status: item.status === "done" ? "done" : existing.status
    });
  }
  return [...byName.values()];
}

export function sanitizeFeatureBacklogForResume(items: FeatureBacklogItem[]): FeatureBacklogItem[] {
  const quality = items.filter(
    (item) => item.source === "clarify" || item.source === "user" || isLikelyFeatureName(item.name)
  );
  if (quality.length < MIN_RESUME_BACKLOG_ITEMS) {
    return [];
  }
  const pending = quality.filter((item) => item.status === "pending").slice(0, MAX_RESUME_PENDING_ITEMS);
  const done = quality.filter((item) => item.status === "done").slice(-MAX_RESUME_DONE_ITEMS);
  return [...pending, ...done];
}

export function formatFeatureBacklogSection(items: FeatureBacklogItem[]): string {
  if (items.length === 0) {
    return "";
  }
  return items
    .map((item) => `- [${item.status}] ${item.name} (${item.source})`)
    .join("\n");
}

export function formatFeatureBacklogForResume(items: FeatureBacklogItem[]): string {
  const sanitized = sanitizeFeatureBacklogForResume(items);
  if (sanitized.length === 0) {
    return "";
  }
  const pending = sanitized.filter((item) => item.status === "pending");
  const done = sanitized.filter((item) => item.status === "done");
  const lines: string[] = [];
  if (pending.length > 0) {
    lines.push("Pending:");
    lines.push(...pending.map((item) => `- ${item.name}`));
  }
  if (done.length > 0) {
    lines.push("Done (recent):");
    lines.push(...done.map((item) => `- [done] ${item.name}`));
  }
  return lines.join("\n");
}

export function serializeFeatureBacklog(items: FeatureBacklogItem[]): Array<{
  name: string;
  source: FeatureBacklogSource;
  status: FeatureBacklogStatus;
}> {
  return items.map((item) => ({ name: item.name, source: item.source, status: item.status }));
}

export function isLikelyFeatureName(name: string): boolean {
  const normalized = normalizeFeatureName(name);
  if (normalized.length < 2) {
    return false;
  }
  if (HEADER_CELL_PATTERN.test(normalized)) {
    return false;
  }
  if (LEGEND_PATTERN.test(normalized) || PRIORITY_LEGEND_PATTERN.test(normalized)) {
    return false;
  }
  if (/^[🔴🟡🟢]/u.test(normalized) && /[高中低]/u.test(normalized)) {
    return false;
  }
  if (CODE_PATTERN.test(normalized)) {
    return false;
  }
  if (/^`[^`]+`$/u.test(normalized)) {
    return false;
  }
  if (/^[\w./-]+\.(js|ts|tsx|jsx|json|css|html|md)$/iu.test(normalized)) {
    return false;
  }
  if (ACTION_VERB_PATTERN.test(normalized)) {
    return true;
  }
  if (/[\u3400-\u9fff]/u.test(normalized) && normalized.length >= 2) {
    return true;
  }
  return false;
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, "");
}

function parseMarkdownTables(text: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const lines = text.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed.includes("|")) {
      index += 1;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && (lines[index]?.trim() ?? "").includes("|")) {
      block.push(lines[index]!.trim());
      index += 1;
    }
    if (block.length < 2) {
      continue;
    }
    const headerCells = parseTableCells(block[0] ?? "");
    if (headerCells.length < 2) {
      continue;
    }
    let dataStart = 1;
    if (block[1] !== undefined && isTableSeparatorRow(parseTableCells(block[1]))) {
      dataStart = 2;
    }
    const rows = block
      .slice(dataStart)
      .map((line) => parseTableCells(line))
      .filter((cells) => cells.length >= 2 && !isTableSeparatorRow(cells));
    tables.push({ headers: headerCells, rows });
  }
  return tables;
}

function extractFromTable(table: ParsedTable, source: FeatureBacklogSource): FeatureBacklogItem[] {
  const headerText = table.headers.join(" ");
  if (SKIP_TABLE_HEADER_PATTERN.test(headerText)) {
    return [];
  }
  if (/优先级/iu.test(headerText) && !/任务|功能|feature|task/iu.test(headerText)) {
    return [];
  }
  if (/文件/iu.test(headerText) && !NAME_COLUMN_HEADER_PATTERN.test(headerText)) {
    return [];
  }

  const nameColumnIndex = table.headers.findIndex((header) => NAME_COLUMN_HEADER_PATTERN.test(header));
  const statusColumnIndex = table.headers.findIndex((header) =>
    STATUS_COLUMN_HEADER_PATTERN.test(header)
  );
  const effectiveNameIndex = nameColumnIndex >= 0 ? nameColumnIndex : 0;

  const items: FeatureBacklogItem[] = [];
  for (const row of table.rows) {
    const rawName = row[effectiveNameIndex] ?? "";
    const name = normalizeFeatureName(rawName);
    if (!isLikelyFeatureName(name)) {
      continue;
    }
    const statusText =
      statusColumnIndex >= 0 ? `${row[statusColumnIndex] ?? ""} ${row.join(" ")}` : row.join(" ");
    items.push({
      name,
      source,
      status: resolveStatusFromText(statusText)
    });
  }
  return items;
}

function extractFromSuggestionBullets(
  text: string,
  source: FeatureBacklogSource
): FeatureBacklogItem[] {
  const items: FeatureBacklogItem[] = [];
  const seen = new Set<string>();
  let inSuggestionSection = false;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (SUGGESTION_SECTION_PATTERN.test(trimmed)) {
      inSuggestionSection = true;
      continue;
    }
    if (inSuggestionSection && /^#{1,3}\s+/u.test(trimmed) && !SUGGESTION_SECTION_PATTERN.test(trimmed)) {
      inSuggestionSection = false;
      continue;
    }
    if (!inSuggestionSection) {
      continue;
    }
    if (trimmed.startsWith("|")) {
      continue;
    }
    const match = trimmed.match(SUGGESTION_BULLET_PATTERN);
    if (match?.[1] === undefined) {
      continue;
    }
    const name = normalizeFeatureName(match[1]);
    if (!isLikelyFeatureName(name) || seen.has(name)) {
      continue;
    }
    seen.add(name);
    items.push({ name, source, status: "pending" });
  }
  return items;
}

function parseTableCells(line: string): string[] {
  return line
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function isTableSeparatorRow(cells: string[]): boolean {
  return cells.every((cell) => /^[-:|\s]+$/u.test(cell));
}

function normalizeFeatureName(name: string): string {
  return name
    .replace(/^✅\s*/u, "")
    .replace(/^⬜\s*/u, "")
    .replace(/^\*+/u, "")
    .replace(/\*+$/u, "")
    .replace(/`([^`]+)`/gu, "$1")
    .trim();
}

function resolveStatusFromText(text: string): FeatureBacklogStatus {
  if (/✅|已完成|完成|done|通过/iu.test(text)) {
    return "done";
  }
  if (/跳过|cancel|取消|skipped/iu.test(text)) {
    return "skipped";
  }
  return "pending";
}

function capFeatureBacklog(items: FeatureBacklogItem[]): FeatureBacklogItem[] {
  return items.slice(0, MAX_FEATURE_BACKLOG_ITEMS);
}

function normalizeStatus(value: unknown): FeatureBacklogStatus {
  if (value === "done" || value === "skipped") {
    return value;
  }
  return "pending";
}

function normalizeSource(value: unknown): FeatureBacklogSource {
  if (value === "user" || value === "clarify") {
    return value;
  }
  return "agent";
}
