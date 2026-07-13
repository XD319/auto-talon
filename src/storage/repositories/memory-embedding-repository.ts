import type { DatabaseSync } from "node:sqlite";
import type { MemoryEmbeddingRecord, MemoryEmbeddingRepository } from "../../types/index.js";

export class SqliteMemoryEmbeddingRepository implements MemoryEmbeddingRepository {
  public constructor(private readonly database: DatabaseSync) {}
  public upsert(record: Omit<MemoryEmbeddingRecord, "updatedAt">): MemoryEmbeddingRecord {
    const updatedAt = new Date().toISOString();
    const bytes = Buffer.from(record.embedding.buffer, record.embedding.byteOffset, record.embedding.byteLength);
    this.database.prepare(`INSERT INTO memory_embeddings (memory_id,content_hash,model,dimensions,embedding,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET content_hash=excluded.content_hash,
      model=excluded.model,dimensions=excluded.dimensions,embedding=excluded.embedding,updated_at=excluded.updated_at`)
      .run(record.memoryId, record.contentHash, record.model, record.dimensions, bytes, updatedAt);
    return { ...record, updatedAt };
  }
  public findByMemoryId(memoryId: string): MemoryEmbeddingRecord | null {
    const row = this.database.prepare("SELECT * FROM memory_embeddings WHERE memory_id=?").get(memoryId) as { memory_id:string;content_hash:string;model:string;dimensions:number;embedding:Uint8Array;updated_at:string } | undefined;
    if (!row) return null;
    const bytes = Buffer.from(row.embedding);
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return { memoryId:row.memory_id,contentHash:row.content_hash,model:row.model,dimensions:row.dimensions,embedding:new Float32Array(copy),updatedAt:row.updated_at };
  }
  public remove(memoryId: string): void { this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(memoryId); }
  public count(): number { return (this.database.prepare("SELECT COUNT(*) count FROM memory_embeddings").get() as {count:number}).count; }
}