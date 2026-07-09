import { describe, expect, it } from "vitest";

import { GatewayGuard } from "../src/gateway/index.js";
import { StorageManager } from "../src/storage/database.js";

describe("gateway guard", () => {
  it("rate limits repeated requests", async () => {
    const guard = new GatewayGuard({
      cwd: process.cwd(),
      now: (() => {
        let current = 0;
        return () => current++;
      })()
    });

    const request = {
      requester: {
        externalSessionId: "s1",
        externalUserId: "u1",
        externalUserLabel: null
      },
      taskInput: "hello"
    };

    const decisions = await Promise.all(
      Array.from({ length: 25 }, () => guard.evaluate("test", request))
    );
    expect(decisions.some((decision) => !decision.allowed && decision.reason === "rate_limited")).toBe(true);
  });

  it("denies identities from env denylist", async () => {
    process.env.AGENT_GATEWAY_DENYLIST = "test:u2";
    const guard = new GatewayGuard({
      cwd: process.cwd()
    });
    const decision = await guard.evaluate("test", {
      requester: {
        externalSessionId: "s2",
        externalUserId: "u2",
        externalUserLabel: null
      },
      taskInput: "blocked"
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("denied");
    }
    delete process.env.AGENT_GATEWAY_DENYLIST;
  });

  it("restores rate limit state from sqlite across guard instances", async () => {
    const storage = new StorageManager({ databasePath: ":memory:" });
    try {
      const now = (() => {
        const current = 1_000;
        return () => current;
      })();
      const request = {
        requester: {
          externalSessionId: "persist",
          externalUserId: "user",
          externalUserLabel: null
        },
        taskInput: "hello"
      };
      const first = new GatewayGuard({
        cwd: process.cwd(),
        now,
        rateLimitStore: storage.gatewayRateLimits
      });
      for (let index = 0; index < 20; index += 1) {
        const decision = await first.evaluate("adapter", request);
        expect(decision.allowed).toBe(true);
      }
      const limited = await first.evaluate("adapter", request);
      expect(limited.allowed).toBe(false);
      if (!limited.allowed) {
        expect(limited.reason).toBe("rate_limited");
      }

      const second = new GatewayGuard({
        cwd: process.cwd(),
        now,
        rateLimitStore: storage.gatewayRateLimits
      });
      const restored = await second.evaluate("adapter", request);
      expect(restored.allowed).toBe(false);
      if (!restored.allowed) {
        expect(restored.reason).toBe("rate_limited");
      }
    } finally {
      storage.close();
    }
  });
});
