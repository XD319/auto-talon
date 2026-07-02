import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { LocalPolicyConfig, Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "scripted-provider";

  public constructor(
    private readonly responder: (input: ProviderInput) => Promise<ProviderResponse> | ProviderResponse
  ) {}

  public async generate(input: ProviderInput): Promise<ProviderResponse> {
    return this.responder(input);
  }
}

const tempPaths: string[] = [];

const WRITE_APPROVAL_POLICY: LocalPolicyConfig = {
  defaultEffect: "deny",
  rules: [
    {
      description: "Workspace file writes require approval in this fixture.",
      effect: "allow_with_approval",
      id: "workspace-write-needs-approval",
      match: {
        capabilities: ["filesystem.write"],
        pathScopes: ["workspace"]
      },
      priority: 80
    },
    {
      description: "Shell execution requires approval.",
      effect: "allow_with_approval",
      id: "shell-needs-approval",
      match: {
        capabilities: ["shell.execute"]
      },
      priority: 80
    },
    {
      description: "Reads are allowed.",
      effect: "allow",
      id: "file-read-allow",
      match: {
        capabilities: ["filesystem.read"],
        pathScopes: ["workspace"]
      },
      priority: 70
    }
  ],
  source: "local"
};

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) {
      await fs.rm(path, { force: true, recursive: true });
    }
  }
});

describe("interaction mode approval", () => {
  it("auto-allows filesystem writes in acceptEdits mode without pending approval", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WRITE_APPROVAL_POLICY,
      provider: new ScriptedProvider((input) => {
        const toolMessages = input.messages.filter((message) => message.role === "tool");
        if (toolMessages.length === 0) {
          return {
            kind: "tool_calls",
            message: "Write the file.",
            toolCalls: [
              {
                input: { content: "accepted\n", path: "accepted.txt" },
                reason: "Apply the requested edit.",
                toolCallId: "accept-edits-write",
                toolName: "write_file"
              }
            ],
            usage: { inputTokens: 1, outputTokens: 1 }
          };
        }
        return { kind: "final", message: "Done.", usage: { inputTokens: 1, outputTokens: 1 } };
      })
    });

    try {
      const runOptions = createDefaultRunOptions("update accepted.txt", workspaceRoot, handle.config);
      runOptions.interactionMode = "acceptEdits";
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("succeeded");
      expect(handle.service.listPendingApprovals()).toHaveLength(0);
      expect(await fs.readFile(join(workspaceRoot, "accepted.txt"), "utf8")).toBe("accepted\n");
      expect(
        handle.service
          .traceTask(result.task.taskId)
          .some((event) => event.eventType === "accept_edits_auto_allowed")
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("still requires approval for shell in acceptEdits mode", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      policyConfig: WRITE_APPROVAL_POLICY,
      provider: new ScriptedProvider(() => ({
        kind: "tool_calls",
        message: "Run shell.",
        toolCalls: [
          {
            input: { command: "node check.js" },
            reason: "Verify the change.",
            toolCallId: "accept-edits-shell",
            toolName: "shell"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    });

    try {
      const runOptions = createDefaultRunOptions("run verification", workspaceRoot, handle.config);
      runOptions.interactionMode = "acceptEdits";
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("waiting_approval");
      expect(handle.service.listPendingApprovals()).toHaveLength(1);
      expect(handle.service.listPendingApprovals()[0]?.toolName).toBe("shell");
    } finally {
      handle.close();
    }
  });

  it("requires approval for agent workspace writes when agentWriteApproval is on", async () => {
    const workspaceRoot = await createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        interactionModes: {
          agentWriteApproval: "on"
        }
      },
      provider: new ScriptedProvider(() => ({
        kind: "tool_calls",
        message: "Write file.",
        toolCalls: [
          {
            input: { content: "needs approval\n", path: "agent-write.txt" },
            reason: "Implement the change.",
            toolCallId: "agent-write",
            toolName: "write_file"
          }
        ],
        usage: { inputTokens: 1, outputTokens: 1 }
      }))
    });

    try {
      const runOptions = createDefaultRunOptions("write agent-write.txt", workspaceRoot, handle.config);
      runOptions.interactionMode = "agent";
      const result = await handle.service.runTask(runOptions);

      expect(result.task.status).toBe("waiting_approval");
      expect(handle.service.listPendingApprovals()[0]?.toolName).toBe("write_file");
    } finally {
      handle.close();
    }
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = join(tmpdir(), `auto-talon-interaction-mode-${Date.now()}-${Math.random()}`);
  await fs.mkdir(workspaceRoot, { recursive: true });
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
