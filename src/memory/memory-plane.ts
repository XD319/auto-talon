import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ContextPolicy } from "../policy/context-policy.js";
import { RecallEngine, overlapRatio, uniqueStrings } from "../recall/recall-engine.js";
import type { TraceService } from "../tracing/trace-service.js";
import { CompactTriggerPolicy } from "./compact-policy.js";
import { rrf, type MemorySearchHit, type MemorySearchProvider } from "./search-provider.js";
import { asSqliteFtsProvider } from "./create-memory-search-provider.js";
import type {
  ContextFragment,
  MemoryDraft,
  MemoryQuery,
  MemoryRecallCandidate,
  MemoryRecallRequest,
  MemoryRecallResult,
  MemoryRecord,
  MemoryRepository,
  MemoryReviewRequest,
  MemoryScope,
  MemorySnapshotDiff,
  MemorySnapshotRecord,
  MemorySnapshotRepository,
  SessionCompactInput,
  SessionCompactResult,
  TaskRecord
} from "../types/index.js";

const memoryReviewSchema = z.object({
  memoryId: z.string().min(1),
  note: z.string().min(1),
  reviewerId: z.string().min(1),
  status: z.enum(["verified", "rejected", "stale", "archived"])
});

export interface MemoryPlaneDependencies {
  contextPolicy: ContextPolicy;
  memoryRepository: MemoryRepository;
  memorySnapshotRepository: MemorySnapshotRepository;
  traceService: TraceService;
  searchProvider?: MemorySearchProvider;
}

export interface BuildContextResult {
  recall: MemoryRecallResult;
  fragments: ContextFragment[];
}

export class MemoryPlane {
  private readonly recallEngine = new RecallEngine();
  private readonly compactPolicy = new CompactTriggerPolicy();

  public constructor(private readonly dependencies: MemoryPlaneDependencies) {}

  public buildContext(task: TaskRecord): BuildContextResult {
    this.ageExpiredMemories();

    const recall = this.recall({
      profileScopeKey: createProfileScopeKey(task),
      limit: 6,
      projectScopeKey: task.cwd,
      query: task.input,
      taskId: task.taskId
    });

    this.recordRecall(task.taskId, recall);

    return {
      fragments: recall.selectedFragments,
      recall
    };
  }

  public recordRecall(taskId: string, recall: MemoryRecallResult): void {
    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "memory_recalled",
      payload: {
        blockedMemoryIds: recall.decisions
          .filter((decision) => !decision.allowed)
          .map((decision) => decision.fragment.memoryId),
        entries: recall.candidates.map((candidate) => {
          const decision =
            recall.decisions.find((item) => item.fragment.memoryId === candidate.memory.memoryId) ??
            null;
          return {
            blocked: decision?.allowed === false,
            confidence: candidate.memory.confidence,
            downrankReasons: candidate.downrankReasons,
            explanation: candidate.explanation,
            filterReason: decision?.allowed === false ? decision.reason : null,
            filterReasonCode: decision?.allowed === false ? decision.reasonCode : null,
            memoryId: candidate.memory.memoryId,
            privacyLevel: candidate.memory.privacyLevel,
            retentionPolicyKind: candidate.memory.retentionPolicy.kind,
            selected: recall.selectedFragments.some(
              (fragment) => fragment.memoryId === candidate.memory.memoryId
            ),
            sourceType: candidate.memory.sourceType,
            status: candidate.memory.status,
            title: candidate.memory.title
          };
        }),
        query: recall.query,
        selectedMemoryIds: recall.selectedFragments.map((fragment) => fragment.memoryId),
        selectedScopes: recall.selectedFragments.map((fragment) => fragment.scope)
      },
      stage: "memory",
      summary: `Selective recall returned ${recall.selectedFragments.length} memory fragments`,
      taskId
    });
  }

  public recordFinalOutcome(task: TaskRecord, output: string): MemoryRecord[] {
    void task;
    void output;
    return [];
  }

  public compactSession(input: SessionCompactInput): Promise<SessionCompactResult> {
    const decision = this.compactPolicy.shouldCompact(input);
    if (!decision.triggered) {
      return Promise.resolve({
        reason: null,
        replacementMessages: input.messages.map((message) => ({
          content: message.content,
          role: toConversationRole(message.role)
        })),
        summaryMemory: null,
        triggered: false
      });
    }

    const summary = summarizeCompactMessages(input);
    return Promise.resolve({
      reason:
        decision.reason === "token_budget" ||
        decision.reason === "tool_call_count" ||
        decision.reason === "iteration_count"
          ? decision.reason
          : "message_count",
      replacementMessages: [
        {
          content: `Session summary:\n${summary}`,
          role: "system"
        },
        ...input.messages.slice(-3).map((message) => ({
          content: message.content,
          role: toConversationRole(message.role)
        }))
      ],
      summaryMemory: null,
      triggered: true
    });
  }

  public list(query?: MemoryQuery): MemoryRecord[] {
    this.ageExpiredMemories();
    return this.dependencies.memoryRepository.list(query);
  }

  public writeMemory(record: MemoryDraft): MemoryRecord | null {
    return this.persistMemoryIfAllowed(record);
  }

  public showScope(scope: MemoryScope, scopeKey: string): {
    memories: MemoryRecord[];
    snapshots: MemorySnapshotRecord[];
  } {
    return {
      memories: this.list({
        includeArchived: true,
        includeExpired: true,
        includeRejected: true,
        includeStale: true,
        scope,
        scopeKey
      }),
      snapshots: this.dependencies.memorySnapshotRepository.listByScope(scope, scopeKey)
    };
  }

  public reviewMemory(request: MemoryReviewRequest): MemoryRecord {
    const parsed = memoryReviewSchema.parse(request);
    const current = this.dependencies.memoryRepository.findById(parsed.memoryId);
    if (current === null) {
      throw new Error(`Memory ${parsed.memoryId} was not found.`);
    }

    const updated = this.dependencies.memoryRepository.update(parsed.memoryId, {
      confidence:
        parsed.status === "verified"
          ? Math.max(current.confidence, 0.9)
          : parsed.status === "rejected"
            ? Math.min(current.confidence, 0.1)
            : Math.min(current.confidence, 0.4),
      lastVerifiedAt:
        parsed.status === "verified" ? new Date().toISOString() : current.lastVerifiedAt,
      metadata: {
        ...current.metadata,
        reviewNote: parsed.note,
        reviewedBy: parsed.reviewerId
      },
      status: parsed.status
    });
    this.syncSearchIndex(updated);
    return updated;
  }

  public resolveConflict(input: {
    keepMemoryId: string;
    archiveMemoryId: string;
    reviewerId: string;
    note?: string;
  }): { kept: MemoryRecord; archived: MemoryRecord } {
    const kept = this.dependencies.memoryRepository.findById(input.keepMemoryId);
    const rival = this.dependencies.memoryRepository.findById(input.archiveMemoryId);
    if (kept === null) {
      throw new Error(`Memory ${input.keepMemoryId} was not found.`);
    }
    if (rival === null) {
      throw new Error(`Memory ${input.archiveMemoryId} was not found.`);
    }
    const note =
      input.note ??
      `Conflict resolved: kept ${input.keepMemoryId}, archived ${input.archiveMemoryId}`;
    const archived = this.reviewMemory({
      memoryId: rival.memoryId,
      note,
      reviewerId: input.reviewerId,
      status: "archived"
    });
    const updatedKept = this.dependencies.memoryRepository.update(kept.memoryId, {
      conflictsWith: kept.conflictsWith.filter((id) => id !== rival.memoryId),
      confidence: Math.max(kept.confidence, 0.9),
      lastVerifiedAt: new Date().toISOString(),
      metadata: {
        ...kept.metadata,
        conflictResolvedAgainst: rival.memoryId,
        reviewNote: note,
        reviewedBy: input.reviewerId
      },
      status: "verified"
    });
    this.syncSearchIndex(updatedKept);
    this.dependencies.traceService.record({
      actor: `reviewer.${input.reviewerId}`,
      eventType: "memory_written",
      payload: {
        memoryId: updatedKept.memoryId,
        privacyLevel: updatedKept.privacyLevel,
        scope: updatedKept.scope,
        sourceType: updatedKept.sourceType,
        status: updatedKept.status
      },
      stage: "memory",
      summary: `Resolved memory conflict; kept ${updatedKept.memoryId}, archived ${archived.memoryId}`,
      taskId: "memory-admin"
    });
    return { archived, kept: updatedKept };
  }

  public createSnapshot(input: {
    createdBy: string;
    label: string;
    scope: MemoryScope;
    scopeKey: string;
  }): MemorySnapshotRecord {
    const memories = this.list({
      includeArchived: true,
      includeExpired: true,
      includeRejected: true,
      includeStale: true,
      scope: input.scope,
      scopeKey: input.scopeKey
    });
    const snapshot = this.dependencies.memorySnapshotRepository.create({
      createdBy: input.createdBy,
      label: input.label,
      memoryIds: memories.map((memory) => memory.memoryId),
      metadata: {
        memoryCount: memories.length
      },
      scope: input.scope,
      scopeKey: input.scopeKey,
      summary: `Snapshot of ${input.scope} memory with ${memories.length} records`
    });

    this.dependencies.traceService.record({
      actor: `reviewer.${input.createdBy}`,
      eventType: "memory_snapshot_created",
      payload: {
        memoryCount: memories.length,
        scope: input.scope,
        scopeKey: input.scopeKey,
        snapshotId: snapshot.snapshotId
      },
      stage: "memory",
      summary: `Snapshot ${snapshot.label} created`,
      taskId: "memory-admin"
    });

    return snapshot;
  }

  public compareSnapshot(snapshotId: string): MemorySnapshotDiff | null {
    const current = this.dependencies.memorySnapshotRepository.findById(snapshotId);
    if (current === null) {
      return null;
    }

    const latest = this.dependencies.memorySnapshotRepository.listByScope(current.scope, current.scopeKey)[0];
    if (latest === undefined) {
      return null;
    }

    return {
      addedMemoryIds: latest.memoryIds.filter((memoryId) => !current.memoryIds.includes(memoryId)),
      removedMemoryIds: current.memoryIds.filter((memoryId) => !latest.memoryIds.includes(memoryId)),
      snapshotId
    };
  }

  public recall(request: MemoryRecallRequest): MemoryRecallResult {
    const listed = [
      ...this.dependencies.memoryRepository.list({
        includeExpired: false,
        limit: request.limit * 3,
        scope: "project",
        scopeKey: request.projectScopeKey
      }),
      ...this.dependencies.memoryRepository.list({
        includeExpired: false,
        limit: request.limit * 3,
        scope: "profile",
        scopeKey: request.profileScopeKey
      })
    ];
    const keywordRanked = this.recallEngine.rankMemory(listed, request.query, request.limit);
    const ftsHits = this.searchSync(request);
    const rankedCandidates = mergeKeywordAndFtsCandidates(keywordRanked, ftsHits, request.limit);

    const fragments = rankedCandidates.map((candidate) => candidateToFragment(candidate));
    const filtered = this.dependencies.contextPolicy.filterForModelContext({
      fragments
    });

    return {
      candidates: rankedCandidates,
      decisions: filtered.decisions,
      query: request.query,
      selectedFragments: filtered.allowedFragments
    };
  }

  public searchMemories(query: string, limit = 5): MemorySearchHit[] {
    const fts = asSqliteFtsProvider(this.dependencies.searchProvider);
    if (fts !== null) {
      return fts.searchSync(query, limit);
    }
    return this.recallEngine.rankMemory(this.list({ includeExpired: false }), query, limit).map((candidate) => ({
      memory: candidate.memory,
      provider: "keyword",
      score: candidate.finalScore
    }));
  }

  private searchSync(request: MemoryRecallRequest): MemorySearchHit[] {
    const fts = asSqliteFtsProvider(this.dependencies.searchProvider);
    if (fts === null) {
      return [];
    }
    return fts.searchSync(request.query, request.limit, [
      { scope: "project", scopeKey: request.projectScopeKey },
      { scope: "profile", scopeKey: request.profileScopeKey }
    ]);
  }

  private syncSearchIndex(memory: MemoryRecord): void {
    const provider = this.dependencies.searchProvider;
    if (provider === undefined) {
      return;
    }
    const fts = asSqliteFtsProvider(provider);
    if (fts !== null) {
      if (memory.status === "verified") {
        fts.upsertSync(memory);
      } else {
        fts.removeSync(memory.memoryId);
      }
    }
    // Keep optional embedding primary in sync (non-blocking).
    if (provider.name.includes("openai") || provider.name.includes("+")) {
      void (memory.status === "verified" ? provider.upsert(memory) : provider.remove(memory.memoryId)).catch(
        () => undefined
      );
    }
  }

  private persistMemoryIfAllowed(record: MemoryDraft): MemoryRecord | null {
    if (record.scope === "working") {
      this.dependencies.traceService.record({
        actor: "memory.plane",
        eventType: "memory_write_rejected",
        payload: {
          reason: "working_scope_moved_to_session_summary",
          scope: record.scope
        },
        stage: "memory",
        summary: "Rejected working memory write; use SessionSummary instead",
        taskId: record.source.taskId ?? "memory-admin"
      });
      return null;
    }
    if (record.scope === "project" || record.scope === "profile") {
      const decision = this.dependencies.contextPolicy.decideLongTermWrite({
        content: record.content,
        privacyLevel: record.privacyLevel,
        scope: record.scope,
        sourceLabel: record.source.label
      });
      if (!decision.allowed) {
        return null;
      }
    }

    return this.persistMemory(record);
  }

  private persistMemory(record: MemoryDraft): MemoryRecord {
    const normalized = {
      ...record,
      conflictsWith: record.conflictsWith ?? [],
      keywords: uniqueStrings(record.keywords),
      metadata: record.metadata ?? {},
      summary: summarize(record.summary),
      title: summarize(record.title, 80)
    };
    const conflictIds = this.findConflicts(normalized.scope, normalized.scopeKey, normalized);
    const persisted = this.dependencies.memoryRepository.create({
      ...normalized,
      conflictsWith: uniqueStrings([...normalized.conflictsWith, ...conflictIds])
    });

    for (const conflictId of conflictIds) {
      const conflict = this.dependencies.memoryRepository.findById(conflictId);
      if (conflict === null) {
        continue;
      }

      this.dependencies.memoryRepository.update(conflictId, {
        conflictsWith: uniqueStrings([...conflict.conflictsWith, persisted.memoryId])
      });
    }

    this.dependencies.traceService.record({
      actor: "memory.plane",
      eventType: "memory_written",
      payload: {
        memoryId: persisted.memoryId,
        privacyLevel: persisted.privacyLevel,
        scope: persisted.scope,
        sourceType: persisted.sourceType,
        status: persisted.status
      },
      stage: "memory",
      summary: `Memory ${persisted.memoryId} persisted in ${persisted.scope} scope`,
      taskId: persisted.source.taskId ?? "memory-admin"
    });

    this.syncSearchIndex(persisted);
    return persisted;
  }

  private ageExpiredMemories(): void {
    const now = new Date().toISOString();
    for (const memory of this.dependencies.memoryRepository.list({
      includeExpired: true,
      includeRejected: true
    })) {
      if (memory.expiresAt !== null && memory.expiresAt <= now && memory.status !== "rejected") {
        const updated = this.dependencies.memoryRepository.update(memory.memoryId, {
          status: "stale"
        });
        this.syncSearchIndex(updated);
      }
    }
  }

  private findConflicts(
    scope: MemoryScope,
    scopeKey: string,
    draft: Pick<MemoryDraft, "content" | "keywords" | "summary">
  ): string[] {
    return this.dependencies.memoryRepository
      .list({
        includeExpired: true,
        includeRejected: false,
        scope,
        scopeKey
      })
      .filter((memory) => {
        const overlap = overlapRatio(memory.keywords, draft.keywords);
        return overlap >= 0.5 && memory.content !== draft.content && memory.summary !== draft.summary;
      })
      .map((memory) => memory.memoryId);
  }
}

export function createProfileScopeKey(task: Pick<TaskRecord, "agentProfileId" | "requesterUserId">): string {
  return `${task.requesterUserId}:${task.agentProfileId}`;
}

/** @deprecated use createProfileScopeKey */
export const createAgentScopeKey = createProfileScopeKey;

function mergeKeywordAndFtsCandidates(
  keywordRanked: MemoryRecallCandidate[],
  ftsHits: MemorySearchHit[],
  limit: number
): MemoryRecallCandidate[] {
  if (ftsHits.length === 0) {
    return keywordRanked.slice(0, limit);
  }
  const keywordAsHits: MemorySearchHit[] = keywordRanked.map((candidate, index) => ({
    memory: candidate.memory,
    provider: "keyword",
    score: candidate.finalScore > 0 ? candidate.finalScore : 1 / (61 + index)
  }));
  const fused = rrf(ftsHits, keywordAsHits, limit);
  const byId = new Map(keywordRanked.map((candidate) => [candidate.memory.memoryId, candidate]));
  return fused.map((hit, index) => {
    const existing = byId.get(hit.memory.memoryId);
    if (existing !== undefined) {
      return {
        ...existing,
        finalScore: Number((existing.finalScore + hit.score).toFixed(4)),
        explanation: `${existing.explanation}; fts=${hit.score.toFixed(3)}; provider=${hit.provider}`
      };
    }
    return {
      confidenceScore: hit.memory.confidence,
      downrankReasons: [],
      explanation: `fts=${hit.score.toFixed(3)}; provider=${hit.provider}; scope=${hit.memory.scope}; source=${hit.memory.source.label}`,
      finalScore: Number((hit.score + 1 / (61 + index)).toFixed(4)),
      freshnessScore: hit.memory.status === "verified" ? 1 : 0.5,
      keywordScore: hit.score,
      memory: hit.memory
    };
  });
}

function candidateToFragment(candidate: MemoryRecallCandidate): ContextFragment {
  return {
    confidence: candidate.memory.confidence,
    explanation: `${candidate.explanation}; source=${candidate.memory.source.label}`,
    fragmentId: randomUUID(),
    memoryId: candidate.memory.memoryId,
    privacyLevel: candidate.memory.privacyLevel,
    retentionPolicy: candidate.memory.retentionPolicy,
    scope: candidate.memory.scope,
    sourceType: candidate.memory.sourceType,
    status: candidate.memory.status,
    text: `[${candidate.memory.scope}] ${candidate.memory.title}: ${candidate.memory.summary}`,
    title: candidate.memory.title
  };
}

function summarize(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

function summarizeCompactMessages(input: SessionCompactInput): string {
  const userMessages = input.messages.filter((message) => message.role === "user");
  const assistantMessages = input.messages.filter((message) => message.role === "assistant");
  const toolMessages = input.messages.filter((message) => message.role === "tool");
  return [
    `goal=${summarize(userMessages.at(0)?.content ?? "", 220) || "[n/a]"}`,
    `latest_user_request=${summarize(userMessages.at(-1)?.content ?? "", 220) || "[n/a]"}`,
    `completed_work=${summarize(assistantMessages.slice(-3).map((message) => message.content).join(" | "), 260) || "[n/a]"}`,
    `tool_signals=${summarize(toolMessages.slice(-3).map((message) => message.content).join(" | "), 260) || "[n/a]"}`
  ].join("\n");
}

function toConversationRole(role: string): "assistant" | "system" | "tool" | "user" {
  return role === "assistant" || role === "system" || role === "tool" || role === "user"
    ? role
    : "system";
}
