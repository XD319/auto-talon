import { describe, expect, it, vi } from "vitest";

import { ProviderRouter } from "../src/providers/routing/provider-router.js";
import type { Provider } from "../src/types/index.js";

function stubProvider(name: string): Provider {
  return {
    generate() {
      return Promise.resolve({ kind: "final", message: "ok" });
    },
    model: `${name}-model`,
    name
  };
}

describe("provider router main override", () => {
  const routerConfig = {
    helpers: { classify: null, recallRank: null, summarize: "cheap" },
    mode: "quality_first" as const,
    providers: { balanced: "mock", cheap: "mock", quality: "openai" }
  };
  const noopTrace = { record: vi.fn() } as never;
  const noopAudit = { record: vi.fn() } as never;

  it("routes by tier when no explicit override is set", () => {
    const router = new ProviderRouter(
      routerConfig,
      (name) => stubProvider(name),
      { isDowngradeActive: () => false },
      noopTrace,
      noopAudit
    );

    const selected = router.selectProvider({ kind: "main", taskId: "t1", sessionId: null });
    expect(selected.providerName).toBe("openai");
    expect(selected.reason).toContain("routing mode");
  });

  it("prefers explicit main override over routing tiers", () => {
    const override = stubProvider("vendor-a");
    const router = new ProviderRouter(
      routerConfig,
      (name) => stubProvider(name),
      { isDowngradeActive: () => false },
      noopTrace,
      noopAudit
    );
    router.setMainProvider(override);

    const selected = router.selectProvider({ kind: "main", taskId: "t1", sessionId: null });
    expect(selected.provider).toBe(override);
    expect(selected.reason).toBe("explicit model switch");
  });

  it("prefers soft budget downgrade over explicit override", () => {
    const override = stubProvider("vendor-a");
    const router = new ProviderRouter(
      routerConfig,
      (name) => stubProvider(name),
      { isDowngradeActive: () => true },
      noopTrace,
      noopAudit
    );
    router.setMainProvider(override);

    const selected = router.selectProvider({ kind: "main", taskId: "t1", sessionId: null });
    expect(selected.providerName).toBe("mock");
    expect(selected.reason).toBe("soft budget downgrade");
  });
});
