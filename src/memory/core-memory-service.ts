import { randomUUID } from "node:crypto";

import type {
  ContextFragment,
  MemoryRecord,
  MemoryRepository,
  SessionCoreSnapshotRecord,
  SessionCoreSnapshotRepository
} from "../types/index.js";

export interface CoreMemoryConfig {
  profileTokenBudget: number;
  projectTokenBudget: number;
}

export class CoreMemoryService {
  public constructor(
    private readonly memoryRepository: MemoryRepository,
    private readonly snapshotRepository: SessionCoreSnapshotRepository,
    private readonly config: CoreMemoryConfig
  ) {}

  public load(input: {
    sessionId: string;
    profileScopeKey: string;
    projectScopeKey: string;
  }): { snapshot: SessionCoreSnapshotRecord; fragments: ContextFragment[] } {
    const existing = this.snapshotRepository.findBySessionId(input.sessionId);
    const snapshot = existing ?? this.createSnapshot(input);
    return { snapshot, fragments: snapshotToFragments(snapshot) };
  }

  private createSnapshot(input: {
    sessionId: string;
    profileScopeKey: string;
    projectScopeKey: string;
  }): SessionCoreSnapshotRecord {
    const profile = selectCore(
      this.memoryRepository.list({
        includeArchived: false,
        includeExpired: false,
        includeRejected: false,
        includeStale: false,
        scope: "profile",
        scopeKey: input.profileScopeKey,
        tier: "core"
      }),
      this.config.profileTokenBudget
    );
    const project = selectCore(
      this.memoryRepository.list({
        includeArchived: false,
        includeExpired: false,
        includeRejected: false,
        includeStale: false,
        scope: "project",
        scopeKey: input.projectScopeKey,
        tier: "core"
      }),
      this.config.projectTokenBudget
    );
    return this.snapshotRepository.create({
      sessionId: input.sessionId,
      profileScopeKey: input.profileScopeKey,
      projectScopeKey: input.projectScopeKey,
      profileMemoryIds: profile.memories.map((item) => item.memoryId),
      projectMemoryIds: project.memories.map((item) => item.memoryId),
      profileText: renderBlock("USER PROFILE", profile, this.config.profileTokenBudget),
      projectText: renderBlock("PROJECT MEMORY", project, this.config.projectTokenBudget)
    });
  }
}

export function selectCore(
  records: MemoryRecord[],
  tokenBudget: number
): { memories: MemoryRecord[]; tokens: number } {
  const now = new Date().toISOString();
  const sorted = records
    .filter((record) =>
      record.status === "verified" &&
      record.tier === "core" &&
      record.privacyLevel !== "restricted" &&
      (record.expiresAt === null || record.expiresAt > now)
    )
    .sort((left, right) =>
      right.confidence - left.confidence ||
      compareTimestamp(right.lastVerifiedAt, left.lastVerifiedAt) ||
      compareTimestamp(right.updatedAt, left.updatedAt) ||
      left.memoryId.localeCompare(right.memoryId)
    );
  const selected: MemoryRecord[] = [];
  const selectedIds = new Set<string>();
  let tokens = 0;
  for (const record of sorted) {
    if (record.conflictsWith.some((id) => selectedIds.has(id))) continue;
    const cost = estimateTokens(record.content);
    if (tokens + cost > Math.max(0, tokenBudget)) continue;
    selected.push(record);
    selectedIds.add(record.memoryId);
    tokens += cost;
  }
  return { memories: selected, tokens };
}

function renderBlock(
  title: string,
  selected: { memories: MemoryRecord[]; tokens: number },
  budget: number
): string {
  const ids = selected.memories.map((item) => item.memoryId).join(",") || "none";
  const body = selected.memories.length === 0
    ? "[empty]"
    : selected.memories.map((item) => `- ${item.content}`).join("\n");
  return `${title} [${selected.tokens}/${budget} tokens; sources=${ids}]\n${body}`;
}

function snapshotToFragments(snapshot: SessionCoreSnapshotRecord): ContextFragment[] {
  return [
    toFragment("profile", snapshot.profileMemoryIds, snapshot.profileText),
    toFragment("project", snapshot.projectMemoryIds, snapshot.projectText)
  ].filter((fragment) => !fragment.text.endsWith("\n[empty]"));
}

function toFragment(
  scope: "profile" | "project",
  memoryIds: string[],
  text: string
): ContextFragment {
  return {
    fragmentId: randomUUID(),
    memoryId: `core-snapshot:${scope}:${memoryIds.join(",")}`,
    scope,
    title: scope === "profile" ? "USER PROFILE" : "PROJECT MEMORY",
    text,
    sourceType: "system",
    privacyLevel: "internal",
    retentionPolicy: {
      kind: scope,
      reason: "Approved core memory frozen for this session.",
      ttlDays: null
    },
    status: "verified",
    confidence: 1,
    explanation: "approved core memory from frozen session snapshot"
  };
}

function compareTimestamp(left: string | null, right: string | null): number {
  return (left ?? "").localeCompare(right ?? "");
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}