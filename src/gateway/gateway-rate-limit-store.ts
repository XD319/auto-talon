export interface GatewayRateLimitBucket {
  tokens: number;
  updatedAtMs: number;
}

export interface GatewayRateLimitStore {
  load(key: string): GatewayRateLimitBucket | null;
  prune(olderThanMs: number): void;
  save(key: string, state: GatewayRateLimitBucket): void;
}
