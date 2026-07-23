import type { DatabaseSync } from "node:sqlite";

import type { MemoryRecord } from "../types/index.js";
import {
  isExternallyIndexableMemory,
  type MemorySearchHit,
  type MemorySearchProvider
} from "./search-provider.js";

/** SQLite FTS5-backed memory search (Hermes-style local full-text). */
export class SqliteFtsMemorySearchProvider implements MemorySearchProvider {
  public readonly name = "fts";

  public constructor(
    private readonly database: DatabaseSync,
    private readonly memoryLookup: (memoryId: string) => MemoryRecord | null
  ) {}

  public upsert(memory: MemoryRecord): Promise<void> {
    this.upsertSync(memory);
    return Promise.resolve();
  }

  public remove(memoryId: string): Promise<void> {
    this.removeSync(memoryId);
    return Promise.resolve();
  }

  public search(query: string, limit: number): Promise<MemorySearchHit[]> {
    return Promise.resolve(this.searchSync(query, limit));
  }

  public health(): Promise<{ healthy: boolean; detail: string }> {
    const count = this.countIndexed();
    return Promise.resolve({ healthy: true, detail: `${count} memories indexed in FTS` });
  }

  public rebuild(memories: MemoryRecord[]): Promise<void> {
    this.database.exec("DELETE FROM memories_fts");
    if (this.hasTrigram()) {
      this.database.exec("DELETE FROM memories_trigram");
    }
    for (const memory of memories) {
      this.upsertSync(memory);
    }
    return Promise.resolve();
  }

  public upsertSync(memory: MemoryRecord): void {
    this.removeSync(memory.memoryId);
    if (!isExternallyIndexableMemory(memory)) {
      return;
    }
    const content = renderIndexedContent(memory);
    this.database
      .prepare("INSERT INTO memories_fts(memory_id, scope, scope_key, content) VALUES (?, ?, ?, ?)")
      .run(memory.memoryId, memory.scope, memory.scopeKey, content);
    if (this.hasTrigram()) {
      this.database
        .prepare("INSERT INTO memories_trigram(memory_id, scope, scope_key, content) VALUES (?, ?, ?, ?)")
        .run(memory.memoryId, memory.scope, memory.scopeKey, content);
    }
  }

  public removeSync(memoryId: string): void {
    this.database.prepare("DELETE FROM memories_fts WHERE memory_id = ?").run(memoryId);
    if (this.hasTrigram()) {
      this.database.prepare("DELETE FROM memories_trigram WHERE memory_id = ?").run(memoryId);
    }
  }

  public searchSync(
    query: string,
    limit: number,
    scopeFilter?: { scope: string; scopeKey: string }[]
  ): MemorySearchHit[] {
    const matchQuery = buildFtsMatchQuery(query);
    if (matchQuery.length === 0) {
      return this.searchLike(query, limit, scopeFilter);
    }
    const ftsHits = this.searchFtsTable("memories_fts", matchQuery, limit * 2, scopeFilter);
    const trigramHits = this.hasTrigram()
      ? this.searchFtsTable("memories_trigram", matchQuery, limit * 2, scopeFilter)
      : [];
    const merged = new Map<string, MemorySearchHit>();
    for (const hit of [...ftsHits, ...trigramHits]) {
      const current = merged.get(hit.memory.memoryId);
      if (current === undefined || hit.score > current.score) {
        merged.set(hit.memory.memoryId, hit);
      }
    }
    if (merged.size === 0) {
      return this.searchLike(query, limit, scopeFilter);
    }
    return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, limit);
  }

  public coverage(): number {
    const eligible = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM memories
           WHERE status='verified' AND privacy_level IN ('public','internal')`
        )
        .get() as { count: number }
    ).count;
    const indexed = this.countIndexed();
    return eligible === 0 ? 1 : Number((indexed / eligible).toFixed(4));
  }

  private countIndexed(): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM memories_fts").get() as { count: number })
      .count;
  }

  private hasTrigram(): boolean {
    return (
      (
        this.database
          .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = 'memories_trigram'")
          .get() as { ok?: number } | undefined
      )?.ok === 1
    );
  }

  private searchFtsTable(
    table: string,
    matchQuery: string,
    limit: number,
    scopeFilter?: { scope: string; scopeKey: string }[]
  ): MemorySearchHit[] {
    try {
      const rows = this.database
        .prepare(
          `SELECT memory_id, bm25(${table}) AS rank
           FROM ${table}
           WHERE ${table} MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(matchQuery, limit) as Array<{ memory_id: string; rank: number }>;
      return rows
        .map((row, index) => {
          const memory = this.memoryLookup(row.memory_id);
          if (memory === null) {
            return null;
          }
          if (
            scopeFilter !== undefined &&
            !scopeFilter.some((scope) => scope.scope === memory.scope && scope.scopeKey === memory.scopeKey)
          ) {
            return null;
          }
          return {
            memory,
            provider: this.name,
            score: 1 / (1 + index + Math.max(0, row.rank))
          } satisfies MemorySearchHit;
        })
        .filter((hit): hit is MemorySearchHit => hit !== null);
    } catch {
      return [];
    }
  }

  private searchLike(
    query: string,
    limit: number,
    scopeFilter?: { scope: string; scopeKey: string }[]
  ): MemorySearchHit[] {
    const terms = tokens(query);
    if (terms.length === 0) {
      return [];
    }
    const rows = this.database
      .prepare("SELECT memory_id, content FROM memories_fts LIMIT 500")
      .all() as Array<{ memory_id: string; content: string }>;
    return rows
      .map((row) => {
        const memory = this.memoryLookup(row.memory_id);
        if (memory === null) {
          return null;
        }
        if (
          scopeFilter !== undefined &&
          !scopeFilter.some((scope) => scope.scope === memory.scope && scope.scopeKey === memory.scopeKey)
        ) {
          return null;
        }
        const text = row.content.toLowerCase();
        const score = terms.filter((term) => text.includes(term)).length / terms.length;
        return score > 0 ? { memory, provider: this.name, score } : null;
      })
      .filter((hit): hit is MemorySearchHit => hit !== null)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }
}

function renderIndexedContent(memory: MemoryRecord): string {
  return `${memory.title}\n${memory.summary}\n${memory.content}\n${memory.keywords.join(" ")}`;
}

function buildFtsMatchQuery(query: string): string {
  return tokens(query)
    .map((term) => `"${term.replaceAll('"', "")}"`)
    .filter((term) => term.length > 2)
    .slice(0, 12)
    .join(" OR ");
}

function tokens(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length >= 2))];
}
