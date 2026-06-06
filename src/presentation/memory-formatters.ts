import type { InboxItem, MemoryRecord } from "../types/index.js";

export function formatMemoryList(memories: MemoryRecord[]): string {
  if (memories.length === 0) {
    return "No memories found.";
  }

  return memories
    .map(
      (memory) =>
        `${memory.memoryId} | ${displayMemoryScope(memory.scope)}:${memory.scopeKey} | ${memory.status} | confidence=${memory.confidence.toFixed(2)} | privacy=${memory.privacyLevel} | ${memory.title}`
    )
    .join("\n");
}

export function formatMemoryGuide(): string {
  return [
    "Memory layers:",
    "- working | runtime-only context for the current task/session; read-only, not manually persisted",
    "- project | reusable knowledge for the current workspace",
    "- profile | reusable user/profile preferences across tasks",
    "Use `talon memory show <scope>` to inspect a scope."
  ].join("\n");
}

export function formatMemoryRecallExplanation(result: {
  entries: Array<{
    blocked: boolean;
    confidence: number;
    downrankReasons: string[];
    explanation: string;
    filterReason: string | null;
    filterReasonCode: string | null;
    memoryId: string;
    selected: boolean;
    status: string;
    title: string;
  }>;
  query: string;
  selectedMemoryIds: string[];
  taskId: string;
} | null): string {
  if (result === null) {
    return "No memory recall explanation found for that task.";
  }
  const lines = [
    `Task ID: ${result.taskId}`,
    `Query: ${result.query}`,
    `Selected: ${result.selectedMemoryIds.join(", ") || "-"}`
  ];
  if (result.entries.length === 0) {
    lines.push("Entries: none");
    return lines.join("\n");
  }
  lines.push("Entries:");
  for (const entry of result.entries) {
    lines.push(
      `- ${entry.memoryId} | ${entry.title} | selected=${entry.selected} blocked=${entry.blocked} status=${entry.status} confidence=${entry.confidence.toFixed(2)}`
    );
    lines.push(`  explanation=${entry.explanation}`);
    lines.push(
      `  downrank=${entry.downrankReasons.join(",") || "-"} filter=${entry.filterReasonCode ?? "-"} reason=${entry.filterReason ?? "-"}`
    );
  }
  return lines.join("\n");
}

export function formatMemorySuggestionQueue(items: InboxItem[]): string {
  if (items.length === 0) {
    return "No memory suggestions found.";
  }
  return [
    "Memory suggestions:",
    ...items.map(
      (item) =>
        `- ${item.inboxId} | ${item.status} | task=${item.taskId ?? "-"} | ${item.title} | ${item.summary}`
    )
  ].join("\n");
}

export function displayMemoryScope(scope: string): string {
  if (scope === "agent") {
    return "profile";
  }
  if (scope === "session") {
    return "working";
  }
  return scope;
}
