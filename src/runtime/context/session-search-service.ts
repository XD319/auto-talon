import { randomUUID } from "node:crypto";

import type {
  ContextFragment,
  SessionSearchHit,
  SessionSummaryRepository
} from "../../types/index.js";

export interface SessionSearchServiceDependencies {
  repository: SessionSummaryRepository;
}

export class SessionSearchService {
  public constructor(private readonly dependencies: SessionSearchServiceDependencies) {}

  public searchAsContext(input: { limit: number; query: string; sessionId: string }): ContextFragment[] {
    const hits = this.dependencies.repository.search(input);
    if (hits.length === 0) {
      return [];
    }
    return [toContextFragment("session", input.sessionId, hits)];
  }

  public searchGlobalAsContext(input: {
    limit: number;
    query: string;
    excludeSessionId?: string | null;
  }): ContextFragment[] {
    const hits = this.dependencies.repository.searchGlobal(input);
    if (hits.length === 0) {
      return [];
    }
    return [toContextFragment("global", input.excludeSessionId ?? null, hits)];
  }
}

function toContextFragment(
  mode: "global" | "session",
  sessionId: string | null,
  hits: SessionSearchHit[]
): ContextFragment {
  const topHits = hits.slice(0, 3);
  const sourceDescription =
    mode === "global"
      ? `global session history matched via FTS5${sessionId === null ? "" : ` excluding session=${sessionId}`}`
      : `session history matched via FTS5 for session=${sessionId}`;
  return {
    confidence: 0.82,
    explanation: sourceDescription,
    fragmentId: randomUUID(),
    memoryId: `session-search:${mode}:${sessionId ?? "none"}:${topHits.map((item) => item.sessionSummaryId).join(",")}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason:
        mode === "global"
          ? "Global session search references are injected for historical recall."
          : "Session search references are injected only for the active session.",
      ttlDays: null
    },
    scope: "session_ref",
    sourceType: "system",
    status: "verified",
    text: topHits
      .map((hit, index) =>
        [
          `Session history ${index + 1}`,
          `session_id=${hit.sessionId}`,
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
