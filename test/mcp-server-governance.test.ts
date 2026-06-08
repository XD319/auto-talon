import { describe, expect, it } from "vitest";

import { McpToolBridge } from "../src/mcp/index.js";
import { createApplication } from "../src/runtime/index.js";

describe("McpToolBridge governance", () => {
  it("denies shell execution for default mcp_external identity", async () => {
    const handle = createApplication(process.cwd());
    try {
      const bridge = new McpToolBridge(handle.infrastructure.toolOrchestrator, process.cwd(), {
        agentProfileId: "reviewer",
        runtimeUserId: "mcp_external"
      });

      const outcome = await bridge.callTool({
        arguments: {
          command: "node -v"
        },
        name: "shell"
      });

      expect(outcome.status).toBe("error");
      expect(outcome.content.errorCode).toMatch(/policy_denied|tool_unavailable/u);
    } finally {
      handle.close();
    }
  });
});
