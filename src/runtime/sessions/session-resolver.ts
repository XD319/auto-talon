import type { SessionRecord } from "../../types/index.js";

export interface ResolveSessionRefResult {
  ambiguous: SessionRecord[];
  session: SessionRecord | null;
}

export function resolveSessionRef(
  ref: string,
  ownerUserId: string,
  sessions: SessionRecord[]
): ResolveSessionRefResult {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { ambiguous: [], session: null };
  }

  const activeForUser = sessions.filter(
    (session) => session.ownerUserId === ownerUserId && session.status === "active"
  );

  const idMatches = activeForUser.filter((session) => session.sessionId.startsWith(trimmed));
  if (idMatches.length === 1) {
    return { ambiguous: [], session: idMatches[0] ?? null };
  }
  if (idMatches.length > 1) {
    return { ambiguous: idMatches, session: null };
  }

  const titleLower = trimmed.toLowerCase();
  const titleMatches = activeForUser.filter(
    (session) =>
      session.title.toLowerCase() === titleLower || session.title.toLowerCase().startsWith(`${titleLower} `)
  );
  if (titleMatches.length === 1) {
    return { ambiguous: [], session: titleMatches[0] ?? null };
  }
  if (titleMatches.length > 1) {
    const latest = [...titleMatches].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return { ambiguous: titleMatches, session: latest ?? null };
  }

  const fuzzyMatches = activeForUser.filter((session) => session.title.toLowerCase().includes(titleLower));
  if (fuzzyMatches.length === 1) {
    return { ambiguous: [], session: fuzzyMatches[0] ?? null };
  }
  if (fuzzyMatches.length > 1) {
    return { ambiguous: fuzzyMatches, session: null };
  }

  return { ambiguous: [], session: null };
}
