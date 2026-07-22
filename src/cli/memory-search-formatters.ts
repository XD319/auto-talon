import type { MemoryRecord, SessionMessageSearchHit } from "../types/index.js";

export function formatSessionMessageSearchHits(hits: SessionMessageSearchHit[]): string {
  if (hits.length === 0) {
    return "No session message hits found.";
  }
  return hits
    .map(
      (hit) =>
        `${hit.messageId} | session=${hit.sessionId} | ${hit.role ?? "message"} | ${(hit.preview ?? "").slice(0, 120)}`
    )
    .join("\n");
}

export function formatCuratedMemorySearchHits(
  hits: Array<{ memory: MemoryRecord; score: number; provider: string }>
): string {
  if (hits.length === 0) {
    return "No curated memory hits found.";
  }
  return hits
    .map(
      (hit) =>
        `${hit.memory.memoryId} | ${hit.memory.scope} | ${hit.provider} | score=${hit.score.toFixed(3)} | ${hit.memory.title}`
    )
    .join("\n");
}
