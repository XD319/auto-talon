import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { SessionMessageSearchService } from "../src/runtime/sessions/session-message-search-service.js";
import { SessionSearchTool } from "../src/tools/session-search-tool.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await import("node:fs/promises").then((fs) => fs.rm(tempPath, { force: true, recursive: true }));
    }
  }
});

describe("session_search tool", () => {
  it("returns matching session message snippets without calling the model", async () => {
    const workspaceRoot = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(join(tmpdir(), "auto-talon-session-search-tool-"))
    );
    tempPaths.push(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });

    try {
      handle.infrastructure.storage.sessions.create({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        metadata: { source: "cli" },
        ownerUserId: "local-user",
        providerName: "mock",
        sessionId: "session-tool",
        title: "Tool session"
      });
      handle.infrastructure.storage.sessionMessages.append({
        kind: "user",
        messageId: "user-tool",
        payload: {
          id: "user-tool",
          kind: "user",
          text: "find the purple elephant",
          timestamp: "2026-01-01T00:00:00.000Z"
        },
        sessionId: "session-tool"
      });

      const tool = new SessionSearchTool({
        searchService: new SessionMessageSearchService({
          messageRepository: handle.infrastructure.storage.sessionMessages
        })
      });
      const toolContext = {
        agentProfileId: "executor" as const,
        cwd: workspaceRoot,
        iteration: 1,
        signal: AbortSignal.timeout(5_000),
        taskId: "task-tool",
        taskMetadata: {},
        userId: "local-user",
        workspaceRoot
      };
      const preparation = tool.prepare({ query: "purple elephant", limit: 5 }, toolContext);
      const result = await tool.execute(preparation.preparedInput, toolContext);

      expect(result.success).toBe(true);
      expect(String(result.output)).toContain("session-tool");
      expect(String(result.output)).toContain("purple elephant");
    } finally {
      handle.close();
    }
  });
});
