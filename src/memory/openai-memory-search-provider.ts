import { createHash } from "node:crypto";
import type { MemoryEmbeddingRepository, MemoryRecord } from "../types/index.js";
import { isExternallyIndexableMemory, type MemorySearchHit, type MemorySearchProvider } from "./search-provider.js";
export interface OpenAiCompatibleMemorySearchConfig { endpoint: string; model: string; apiKey: string; dimensions: number; timeoutMs: number; batchSize: number }
interface Entry { memory: MemoryRecord; vector: Float32Array; hash: string }
export class OpenAiCompatibleMemorySearchProvider implements MemorySearchProvider {
  public readonly name = "openai_compatible";
  private readonly entries = new Map<string, Entry>();
  public constructor(private readonly config: OpenAiCompatibleMemorySearchConfig, private readonly store?: MemoryEmbeddingRepository) {}
  public async upsert(memory: MemoryRecord): Promise<void> {
    if (!isExternallyIndexableMemory(memory)) { this.entries.delete(memory.memoryId); this.store?.remove(memory.memoryId); return; }
    const text = render(memory); const hash = createHash("sha256").update(`${this.config.model}:${text}`).digest("hex");
    if (this.entries.get(memory.memoryId)?.hash === hash) return;
    const [vector] = await this.embed([text]); if (!vector) throw new Error("Embedding provider returned no vector.");
    this.entries.set(memory.memoryId, { memory, vector, hash });
    this.store?.upsert({ memoryId: memory.memoryId, contentHash: hash, model: this.config.model, dimensions: vector.length, embedding: vector });
  }
  public remove(id: string): Promise<void> { this.entries.delete(id); this.store?.remove(id); return Promise.resolve(); }
  public async search(query: string, limit: number): Promise<MemorySearchHit[]> { const [vector] = await this.embed([query]); if (!vector) return []; return [...this.entries.values()].map((entry) => ({ memory: entry.memory, provider: this.name, score: cosine(vector, entry.vector) })).sort((a, b) => b.score - a.score).slice(0, limit); }
  public async health(): Promise<{ healthy: boolean; detail: string }> { try { await this.embed(["health"]); return { healthy: true, detail: "embedding endpoint reachable" }; } catch (e) { return { healthy: false, detail: e instanceof Error ? e.message : String(e) }; } }
  public async rebuild(memories: MemoryRecord[]): Promise<void> { this.entries.clear(); for (const memory of memories) await this.upsert(memory); }
  private async embed(input: string[]): Promise<Float32Array[]> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try { const response = await fetch(this.config.endpoint, { method: "POST", headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ input, model: this.config.model, dimensions: this.config.dimensions }), signal: controller.signal });
      if (!response.ok) throw new Error(`Embedding provider returned HTTP ${response.status}.`);
      const body = await response.json() as { data?: Array<{ embedding: number[]; index?: number }> };
      return (body.data ?? []).sort((a,b)=>(a.index??0)-(b.index??0)).map((item) => { if (item.embedding.length !== this.config.dimensions) throw new Error(`Embedding dimension mismatch: expected ${this.config.dimensions}, got ${item.embedding.length}.`); return new Float32Array(item.embedding); });
    } finally { clearTimeout(timer); }
  }
}
function render(memory: MemoryRecord): string { return `${memory.title}\n${memory.summary}\n${memory.content}`; }
function cosine(a: Float32Array, b: Float32Array): number { if (a.length !== b.length) throw new Error("Embedding dimension mismatch."); let dot=0, an=0, bn=0; for(let i=0;i<a.length;i+=1){const x=a[i]??0,y=b[i]??0;dot+=x*y;an+=x*x;bn+=y*y;} return an===0||bn===0?0:dot/Math.sqrt(an*bn); }