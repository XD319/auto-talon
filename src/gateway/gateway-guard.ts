import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { GatewayTaskRequest } from "../types/index.js";
import type { GatewayRateLimitStore } from "./gateway-rate-limit-store.js";

const gatewayConfigSchema = z.object({
  allowlist: z.array(z.string().min(1)).optional(),
  denylist: z.array(z.string().min(1)).optional(),
  rateLimit: z
    .object({
      burst: z.number().int().positive().optional(),
      refillPerSecond: z.number().positive().optional()
    })
    .optional()
});

export type GatewayGuardDecision =
  | { allowed: true }
  | { allowed: false; reason: "rate_limited" | "denied" | "auth_failed"; message: string };

export interface GatewayGuardDependencies {
  authHook?: (input: { adapterId: string; request: GatewayTaskRequest }) => Promise<boolean> | boolean;
  cwd: string;
  now?: () => number;
  rateLimitStore?: GatewayRateLimitStore;
}

interface BucketState {
  tokens: number;
  updatedAtMs: number;
}

export class GatewayGuard {
  private readonly allowlist: Set<string>;
  private readonly denylist: Set<string>;
  private readonly burst: number;
  private readonly refillPerSecond: number;
  private readonly authHook: GatewayGuardDependencies["authHook"];
  private readonly now: () => number;
  private readonly rateLimitStore: GatewayRateLimitStore | undefined;
  private readonly buckets = new Map<string, BucketState>();
  private readonly bucketTtlMs = 3_600_000;

  public constructor(dependencies: GatewayGuardDependencies) {
    const config = loadGatewayConfig(dependencies.cwd);
    this.allowlist = new Set(config.allowlist);
    this.denylist = new Set([
      ...config.denylist,
      ...splitList(process.env.AGENT_GATEWAY_DENYLIST)
    ]);
    this.burst = config.rateLimit.burst;
    this.refillPerSecond = config.rateLimit.refillPerSecond;
    this.authHook = dependencies.authHook;
    this.now = dependencies.now ?? (() => Date.now());
    this.rateLimitStore = dependencies.rateLimitStore;
  }

  public async evaluate(adapterId: string, request: GatewayTaskRequest): Promise<GatewayGuardDecision> {
    const requesterKey = request.requester.externalUserId ?? request.requester.externalSessionId;
    const identityKey = `${adapterId}:${requesterKey}`;

    if (this.allowlist.size > 0 && !this.allowlist.has(identityKey)) {
      return {
        allowed: false,
        message: `${identityKey} is not in gateway allowlist.`,
        reason: "denied"
      };
    }
    if (this.denylist.has(identityKey)) {
      return {
        allowed: false,
        message: `${identityKey} is in gateway denylist.`,
        reason: "denied"
      };
    }
    if (!this.consume(identityKey)) {
      return {
        allowed: false,
        message: `${identityKey} exceeded gateway rate limit.`,
        reason: "rate_limited"
      };
    }
    if (this.authHook !== undefined) {
      const authenticated = await this.authHook({ adapterId, request });
      if (!authenticated) {
        return {
          allowed: false,
          message: `${identityKey} failed gateway authentication.`,
          reason: "auth_failed"
        };
      }
    }

    return { allowed: true };
  }

  private consume(key: string): boolean {
    this.pruneBuckets();
    const now = this.now();
    const existing = this.loadBucket(key);
    if (existing === undefined) {
      this.saveBucket(key, { tokens: this.burst - 1, updatedAtMs: now });
      return true;
    }

    const elapsedSeconds = Math.max(0, (now - existing.updatedAtMs) / 1000);
    const replenished = Math.min(this.burst, existing.tokens + elapsedSeconds * this.refillPerSecond);
    if (replenished < 1) {
      this.saveBucket(key, { tokens: replenished, updatedAtMs: now });
      return false;
    }

    this.saveBucket(key, { tokens: replenished - 1, updatedAtMs: now });
    return true;
  }

  private loadBucket(key: string): BucketState | undefined {
    const cached = this.buckets.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.rateLimitStore === undefined) {
      return undefined;
    }
    const persisted = this.rateLimitStore.load(key);
    if (persisted === null) {
      return undefined;
    }
    const bucket = { tokens: persisted.tokens, updatedAtMs: persisted.updatedAtMs };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private saveBucket(key: string, state: BucketState): void {
    this.buckets.set(key, state);
    this.rateLimitStore?.save(key, state);
  }

  private pruneBuckets(): void {
    const now = this.now();
    const cutoff = now - this.bucketTtlMs;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.updatedAtMs > this.bucketTtlMs) {
        this.buckets.delete(key);
      }
    }
    this.rateLimitStore?.prune(cutoff);
  }
}

function loadGatewayConfig(cwd: string): {
  allowlist: string[];
  denylist: string[];
  rateLimit: { burst: number; refillPerSecond: number };
} {
  const configPath = join(cwd, ".auto-talon", "gateway.config.json");
  if (!existsSync(configPath)) {
    return {
      allowlist: [],
      denylist: [],
      rateLimit: { burst: 20, refillPerSecond: 5 }
    };
  }

  const raw = readFileSync(configPath, "utf8").trim();
  let parsed: unknown = {};
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        allowlist: [],
        denylist: [],
        rateLimit: { burst: 20, refillPerSecond: 5 }
      };
    }
  }
  const result = gatewayConfigSchema.safeParse(parsed);
  const config = result.success
    ? result.data
    : {
        allowlist: [],
        denylist: [],
        rateLimit: { burst: 20, refillPerSecond: 5 }
      };

  return {
    allowlist: (config.allowlist ?? []).map((value) => value.trim()).filter(Boolean),
    denylist: (config.denylist ?? []).map((value) => value.trim()).filter(Boolean),
    rateLimit: {
      burst: config.rateLimit?.burst ?? 20,
      refillPerSecond: config.rateLimit?.refillPerSecond ?? 5
    }
  };
}

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
