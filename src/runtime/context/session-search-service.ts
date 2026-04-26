import { randomUUID } from "node:crypto";

import type {
  ContextFragment,
  SessionSearchHit,
  ThreadSessionMemoryRepository
} from "../../types/index.js";

export interface SessionSearchServiceDependencies {
  repository: ThreadSessionMemoryRepository;
}

export class SessionSearchService {
  public constructor(private readonly dependencies: SessionSearchServiceDependencies) {}

  public searchAsContext(input: { limit: number; query: string; threadId: string }): ContextFragment[] {
    const hits = this.dependencies.repository.search(input);
    if (hits.length === 0) {
      return [];
    }
    return [toContextFragment("thread", input.threadId, hits)];
  }

  public searchGlobalAsContext(input: {
    limit: number;
    query: string;
    excludeThreadId?: string | null;
  }): ContextFragment[] {
    const hits = this.dependencies.repository.searchGlobal(input);
    if (hits.length === 0) {
      return [];
    }
    return [toContextFragment("global", input.excludeThreadId ?? null, hits)];
  }
}

function toContextFragment(
  mode: "global" | "thread",
  threadId: string | null,
  hits: SessionSearchHit[]
): ContextFragment {
  const topHits = hits.slice(0, 3);
  const sourceDescription =
    mode === "global"
      ? `global session history matched via FTS5${threadId === null ? "" : ` excluding thread=${threadId}`}`
      : `session history matched via FTS5 for thread=${threadId}`;
  return {
    confidence: 0.82,
    explanation: sourceDescription,
    fragmentId: randomUUID(),
    memoryId: `session-search:${mode}:${threadId ?? "none"}:${topHits.map((item) => item.sessionMemoryId).join(",")}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason:
        mode === "global"
          ? "Global session search references are injected for historical recall."
          : "Session search references are injected only for the active thread.",
      ttlDays: null
    },
    scope: "session_ref",
    sourceType: "system",
    status: "verified",
    text: topHits
      .map((hit, index) =>
        [
          `Session history ${index + 1}`,
          `thread_id=${hit.threadId}`,
          `goal=${hit.goal}`,
          `summary=${hit.summary}`,
          `decisions=${hit.decisions.join("; ") || "[none]"}`,
          `open_loops=${hit.openLoops.join("; ") || "[none]"}`,
          `next_actions=${hit.nextActions.join("; ") || "[none]"}`
        ].join("\n")
      )
      .join("\n\n"),
    title: "Session history"
  };
}
