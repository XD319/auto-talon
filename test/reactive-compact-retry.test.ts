import { describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import { ProviderError } from "../src/providers/provider-error.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class OverflowThenRecoverProvider implements Provider {
  public readonly name = "overflow-then-recover";
  public readonly overflowPayloads: ProviderInput["messages"][] = [];
  public recoveryPayload: ProviderInput["messages"] | null = null;
  private toolCallIssued = false;

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    const hasToolResult = input.messages.some((message) => message.role === "tool");
    if (!this.toolCallIssued) {
      this.toolCallIssued = true;
      return Promise.resolve({
        kind: "tool_calls",
        message: "Inspect workspace",
        toolCalls: [
          {
            input: { path: "." },
            reason: "Create prior context",
            toolCallId: "overflow-glob",
            toolName: "glob"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      });
    }
    if (hasToolResult) {
      this.overflowPayloads.push(input.messages.map((message) => ({ ...message })));
      throw new ProviderError({
        category: "invalid_request",
        message: "context length exceeded",
        providerName: this.name
      });
    }
    this.recoveryPayload = input.messages.map((message) => ({ ...message }));
    return Promise.resolve({
      kind: "final",
      message: "recovered",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

const READ_POLICY: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      effect: "allow",
      description: "Allow workspace reads for the setup tool call.",
      id: "allow-read",
      match: { capabilities: ["filesystem.read"], pathScopes: ["workspace"] },
      priority: 100
    }
  ],
  source: "local"
};

describe("reactive compact provider retry", () => {
  it("rebuilds a smaller provider payload while preserving the current request", async () => {
    const provider = new OverflowThenRecoverProvider();
    const handle = createApplication(process.cwd(), {
      config: { databasePath: ":memory:" },
      policyConfig: READ_POLICY,
      provider
    });
    try {
      const result = await handle.service.runTask(
        createDefaultRunOptions("current request must survive", process.cwd(), handle.config)
      );
      expect(result.task.status).toBe("succeeded");
      expect(provider.overflowPayloads.length).toBeGreaterThan(0);
      expect(provider.recoveryPayload).not.toBeNull();
      expect(provider.recoveryPayload?.some((message) => message.content === "current request must survive")).toBe(true);
      expect(provider.recoveryPayload?.some((message) => message.role === "tool")).toBe(false);
      expect(provider.recoveryPayload!.length).toBeLessThan(provider.overflowPayloads[0]!.length);
    } finally {
      handle.close();
    }
  });
});
