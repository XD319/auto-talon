import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApplication, createDefaultRunOptions } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "scripted-provider";
  public constructor(private readonly responder: () => ProviderResponse) {}
  public generate(input: ProviderInput): Promise<ProviderResponse> {
    void input;
    return Promise.resolve(this.responder());
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("assistant output projection", () => {
  it("projects commitments and next actions without duplicates", async () => {
    const workspaceRoot = await createTempWorkspace();
    const output = ["Commitments:", "- Ship parser", "Next Actions:", "- Add tests", "- Update docs"].join("\n");
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: output,
        usage: { inputTokens: 2, outputTokens: 2 }
      }))
    });

    try {
      const first = await handle.service.runTask(createDefaultRunOptions("run projection", workspaceRoot, handle.config));
      const secondOptions = createDefaultRunOptions("run projection again", workspaceRoot, handle.config);
      secondOptions.threadId = first.task.threadId ?? undefined;
      await handle.service.runTask(secondOptions);

      const threadId = first.task.threadId ?? "";
      const commitments = handle.service.listCommitments({ threadId }).filter((item) => item.source === "assistant_pledge");
      const nextActions = handle.service.listNextActions({ threadId }).filter((item) => item.source === "assistant_pledge");
      expect(commitments).toHaveLength(1);
      expect(commitments[0]?.title).toBe("Ship parser");
      expect(nextActions.map((item) => item.title).sort()).toEqual(["Add tests", "Update docs"]);
    } finally {
      handle.close();
    }
  });

  it("projects blocked lines and lets inbox collector create blocked item", async () => {
    const workspaceRoot = await createTempWorkspace();
    const output = ["Commitments:", "- Deliver release", "Blocked:", "- Waiting for API key"].join("\n");
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") },
      provider: new ScriptedProvider(() => ({
        kind: "final",
        message: output,
        usage: { inputTokens: 2, outputTokens: 2 }
      }))
    });

    try {
      const result = await handle.service.runTask(createDefaultRunOptions("blocked projection", workspaceRoot, handle.config));
      const threadId = result.task.threadId ?? "";
      const blockedActions = handle.service.listNextActions({ threadId }).filter((item) => item.status === "blocked");
      expect(blockedActions.length).toBeGreaterThan(0);

      const inboxItems = handle.service.listInbox({ status: "pending", threadId }).filter((item) => item.category === "task_blocked");
      expect(inboxItems.length).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-projection-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
