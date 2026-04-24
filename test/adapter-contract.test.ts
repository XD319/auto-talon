import { describe, expect, it } from "vitest";

import { GatewayManager } from "../src/gateway/gateway-manager.js";
import { SUPPORTED_ADAPTER_CONTRACT_VERSION, validateAdapterContract } from "../src/gateway/adapter-contract.js";
import type { AdapterDescriptor, GatewayRuntimeApi, InboundMessageAdapter } from "../src/types/index.js";

interface AdapterContractHarness {
  createAdapter(overrides?: Partial<AdapterDescriptor>): InboundMessageAdapter;
}

describe("Gateway adapter contract tests", () => {
  runAdapterContractSuite("null adapter", createNullAdapterHarness());
});

function runAdapterContractSuite(name: string, harness: AdapterContractHarness): void {
  describe(name, () => {
    it("accepts a fully declared descriptor", () => {
      const violations = validateAdapterContract(harness.createAdapter());
      expect(violations).toHaveLength(0);
    });

    it("rejects unsupported contract versions", () => {
      const violations = validateAdapterContract(
        harness.createAdapter({
          contractVersion: SUPPORTED_ADAPTER_CONTRACT_VERSION + 1
        })
      );
      expect(violations.some((violation) => violation.code === "contract_version_unsupported")).toBe(true);
    });

    it("rejects missing contractVersion", () => {
      const adapter = harness.createAdapter();
      (adapter.descriptor as { contractVersion?: unknown }).contractVersion = undefined;
      const violations = validateAdapterContract(adapter);
      expect(violations.some((violation) => violation.code === "contract_version_invalid")).toBe(true);
    });

    it("rejects adapters without text interaction", () => {
      const violations = validateAdapterContract(
        harness.createAdapter({
          capabilities: {
            approvalInteraction: { supported: false },
            attachmentCapability: { supported: false },
            fileCapability: { supported: false },
            streamingCapability: { supported: false },
            structuredCardCapability: { supported: false },
            textInteraction: { supported: false }
          }
        })
      );
      expect(violations.some((violation) => violation.code === "text_interaction_required")).toBe(true);
    });

    it("manager lifecycle starts and stops for valid adapter", async () => {
      const adapter = harness.createAdapter();
      const manager = new GatewayManager(createNoopRuntimeApi(), [adapter]);

      await manager.startAll();
      expect(adapter.descriptor.lifecycleState).toBe("running");

      await manager.stopAll();
      expect(adapter.descriptor.lifecycleState).toBe("stopped");
    });
  });
}

function createNullAdapterHarness(): AdapterContractHarness {
  return {
    createAdapter: (overrides = {}) => createNullAdapter(overrides)
  };
}

function createNullAdapter(overrides: Partial<AdapterDescriptor>): InboundMessageAdapter {
  const descriptor: AdapterDescriptor = {
    adapterId: overrides.adapterId ?? "null-adapter",
    contractVersion: overrides.contractVersion ?? 1,
    capabilities:
      overrides.capabilities ??
      ({
        approvalInteraction: { supported: false },
        attachmentCapability: { supported: false },
        fileCapability: { supported: false },
        streamingCapability: { supported: false },
        structuredCardCapability: { supported: false },
        textInteraction: { supported: true }
      } satisfies AdapterDescriptor["capabilities"]),
    description: overrides.description ?? "No-op test adapter.",
    displayName: overrides.displayName ?? "Null Adapter",
    kind: overrides.kind ?? "sdk",
    lifecycleState: overrides.lifecycleState ?? "created"
  };

  return {
    descriptor,
    start(): Promise<void> {
      return Promise.resolve();
    },
    stop(): Promise<void> {
      return Promise.resolve();
    }
  };
}

function createNoopRuntimeApi(): GatewayRuntimeApi {
  return {
    getTaskSnapshot: () => null,
    listInbox: () => [],
    markInboxDone: () => {
      throw new Error("Not implemented in adapter contract tests.");
    },
    registerOutboundAdapter: () => {
      return;
    },
    resolveApproval: () => Promise.resolve(null),
    submitTask: () => {
      throw new Error("Not implemented in adapter contract tests.");
    },
    subscribeToCompletion: () => () => undefined,
    subscribeToInbox: () => () => undefined,
    subscribeToTaskEvents: () => () => undefined
  };
}
