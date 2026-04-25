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
    return [toContextFragment(input.threadId, hits)];
  }
}

function toContextFragment(threadId: string, hits: SessionSearchHit[]): ContextFragment {
  const topHits = hits.slice(0, 3);
  return {
    confidence: 0.82,
    explanation: `session history matched via FTS5 for thread=${threadId}`,
    fragmentId: randomUUID(),
    memoryId: `session-search:${threadId}:${topHits.map((item) => item.sessionMemoryId).join(",")}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Session search references are injected only for the active thread.",
      ttlDays: null
    },
    scope: "session_ref",
    sourceType: "system",
    status: "verified",
    text: topHits
      .map((hit, index) =>
        [
          `Session history ${index + 1}`,
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
