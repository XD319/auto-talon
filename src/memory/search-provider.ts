import type { MemoryRecord } from "../types/index.js";

export interface MemorySearchHit { memory: MemoryRecord; score: number; provider: string }
export interface MemorySearchProvider {
  readonly name: string;
  upsert(memory: MemoryRecord): Promise<void>;
  remove(memoryId: string): Promise<void>;
  search(query: string, limit: number): Promise<MemorySearchHit[]>;
  health(): Promise<{ healthy: boolean; detail: string }>;
  rebuild(memories: MemoryRecord[]): Promise<void>;
}
export function isExternallyIndexableMemory(memory: MemoryRecord): boolean {
  return memory.privacyLevel !== "restricted" && memory.status === "verified" &&
    (memory.tier === "core" || memory.tier === "retrieval") &&
    (memory.expiresAt === null || memory.expiresAt > new Date().toISOString());
}
export class FtsMemorySearchProvider implements MemorySearchProvider {
  public readonly name = "fts";
  private readonly records = new Map<string, MemoryRecord>();
  public upsert(memory: MemoryRecord): Promise<void> { if (memory.status === "verified") this.records.set(memory.memoryId, memory); else this.records.delete(memory.memoryId); return Promise.resolve(); }
  public remove(id: string): Promise<void> { this.records.delete(id); return Promise.resolve(); }
  public search(query: string, limit: number): Promise<MemorySearchHit[]> {
    const terms = tokens(query);
    return Promise.resolve([...this.records.values()].map((memory) => {
      const text = `${memory.title} ${memory.summary} ${memory.content} ${memory.keywords.join(" ")}`.toLowerCase();
      return { memory, provider: this.name, score: terms.filter((term) => text.includes(term)).length / Math.max(1, terms.length) };
    }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, limit));
  }
  public health(): Promise<{ healthy: boolean; detail: string }> { return Promise.resolve({ healthy: true, detail: `${this.records.size} memories indexed` }); }
  public async rebuild(memories: MemoryRecord[]): Promise<void> { this.records.clear(); for (const memory of memories) await this.upsert(memory); }
}
export class FallbackMemorySearchProvider implements MemorySearchProvider {
  public readonly name: string;
  public constructor(private readonly primary: MemorySearchProvider, private readonly fallback: MemorySearchProvider, private readonly onFallback?: (reason: string) => void) { this.name = `${primary.name}+${fallback.name}`; }
  public async upsert(memory: MemoryRecord): Promise<void> { await this.fallback.upsert(memory); try { await this.primary.upsert(memory); } catch (e) { this.record(e); } }
  public async remove(id: string): Promise<void> { await this.fallback.remove(id); try { await this.primary.remove(id); } catch (e) { this.record(e); } }
  public async search(query: string, limit: number): Promise<MemorySearchHit[]> { try { return rrf(await this.primary.search(query, limit), await this.fallback.search(query, limit), limit); } catch (e) { this.record(e); return this.fallback.search(query, limit); } }
  public async health(): Promise<{ healthy: boolean; detail: string }> { const result = await this.primary.health().catch((e) => ({ healthy: false, detail: String(e) })); return result.healthy ? result : { healthy: true, detail: `fallback active: ${result.detail}` }; }
  public async rebuild(memories: MemoryRecord[]): Promise<void> { await this.fallback.rebuild(memories); try { await this.primary.rebuild(memories); } catch (e) { this.record(e); } }
  private record(error: unknown): void { this.onFallback?.(error instanceof Error ? error.message : String(error)); }
}
export function rrf(first: MemorySearchHit[], second: MemorySearchHit[], limit: number): MemorySearchHit[] {
  const map = new Map<string, MemorySearchHit>();
  for (const list of [first, second]) list.forEach((hit, index) => { const current = map.get(hit.memory.memoryId); map.set(hit.memory.memoryId, { memory: hit.memory, provider: current ? `${current.provider}+${hit.provider}` : hit.provider, score: (current?.score ?? 0) + 1 / (61 + index) }); });
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
function tokens(value: string): string[] { return [...new Set(value.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))]; }