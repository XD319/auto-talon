import type { DatabaseSync } from "node:sqlite";

import type {
  GatewayRateLimitBucket,
  GatewayRateLimitStore
} from "../../gateway/gateway-rate-limit-store.js";

export type { GatewayRateLimitBucket, GatewayRateLimitStore } from "../../gateway/gateway-rate-limit-store.js";

export class SqliteGatewayRateLimitRepository implements GatewayRateLimitStore {
  public constructor(private readonly database: DatabaseSync) {}

  public load(key: string): GatewayRateLimitBucket | null {
    const row = this.database
      .prepare(
        `
          SELECT tokens, updated_at_ms
          FROM gateway_rate_limits
          WHERE rate_limit_key = ?
        `
      )
      .get(key) as { tokens: number; updated_at_ms: number } | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      tokens: row.tokens,
      updatedAtMs: row.updated_at_ms
    };
  }

  public save(key: string, state: GatewayRateLimitBucket): void {
    this.database
      .prepare(
        `
          INSERT INTO gateway_rate_limits (rate_limit_key, tokens, updated_at_ms)
          VALUES (?, ?, ?)
          ON CONFLICT(rate_limit_key) DO UPDATE SET
            tokens = excluded.tokens,
            updated_at_ms = excluded.updated_at_ms
        `
      )
      .run(key, state.tokens, state.updatedAtMs);
  }

  public prune(olderThanMs: number): void {
    this.database
      .prepare(
        `
          DELETE FROM gateway_rate_limits
          WHERE updated_at_ms < ?
        `
      )
      .run(olderThanMs);
  }
}
