import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../src/cli/index.js";
import { createApplication } from "../src/runtime/index.js";

describe("cli memory commands", () => {
  it("supports layered scopes and legacy aliases", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cli-memory-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(workspace);
      await main(["node", "talon", "run", "collect memory context"]);

      await main(["node", "talon", "memory", "list", "--scope", "project"]);
      await main(["node", "talon", "memory", "show", "skill_ref"]);
      await main(["node", "talon", "memory", "show", "session", "--task-id", "missing-task"]);
      await main(["node", "talon", "thread", "list", "--json"]);
      const threadListLog = logSpy.mock.calls
        .map((entry) => String(entry[0] ?? ""))
        .find((entry) => entry.startsWith("["));
      const firstThreadId =
        threadListLog === undefined
          ? null
          : ((JSON.parse(threadListLog) as Array<{ threadId: string }>)[0]?.threadId ?? null);
      expect(firstThreadId).not.toBeNull();
      await main(["node", "talon", "memory", "search", "collect memory context", "--thread", firstThreadId!]);
      await main(["node", "talon", "memory", "search", "last time memory context", "--global"]);

      const output = logSpy.mock.calls.map((entry) => String(entry[0] ?? "")).join("\n");
      expect(output).toContain("No enabled skills found.");
      expect(output).toContain("Scope: working");
      expect(
        output.includes("No session memory hits found.") || output.includes("thread=")
      ).toBe(true);
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("supports memory add, forget, why, and review queue commands", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "talon-cli-memory-ops-"));
    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.chdir(workspace);
      await main(["node", "talon", "run", "collect memory context"]);
      await main(["node", "talon", "memory", "add", "project", "Prefer vitest for memory verification"]);
      await main(["node", "talon", "run", "memory verification guidance"]);
      await main(["node", "talon", "task", "list"]);
      const taskIds = logSpy.mock.calls
        .map((entry) => String(entry[0] ?? ""))
        .filter((entry) => entry.includes(" | "))
        .map((entry) => entry.split(" | ")[0] ?? "")
        .filter((entry) => entry.length > 0);
      const latestTaskId = taskIds.at(-1);
      expect(latestTaskId).toBeTruthy();
      await main(["node", "talon", "memory", "why", "--task", latestTaskId!]);
      await main(["node", "talon", "memory", "list"]);
      const memoryLine = logSpy.mock.calls
        .map((entry) => String(entry[0] ?? ""))
        .find((entry) => entry.includes("Prefer vitest for memory verification"));
      const memoryId = memoryLine?.split(" | ")[0];
      expect(memoryId).toBeTruthy();
      await main(["node", "talon", "memory", "forget", memoryId!]);

      const handle = createApplication(workspace);
      try {
        handle.service.listInbox();
        const item = handle.infrastructure.storage.inbox.create({
          category: "memory_suggestion",
          metadata: {
            memorySuggestionDraft: {
              confidence: 0.91,
              content: "Use project memory suggestions through inbox review.",
              keywords: ["project", "memory", "suggestions", "inbox", "review"],
              metadata: {
                source: "test"
              },
              privacyLevel: "internal",
              retentionPolicy: {
                kind: "project",
                reason: "Test memory suggestion",
                ttlDays: 90
              },
              scope: "project",
              scopeKey: workspace,
              source: {
                label: "Test suggestion",
                sourceType: "manual_review",
                taskId: null,
                toolCallId: null,
                traceEventId: null
              },
              summary: "Inbox reviewed project memory suggestion",
              title: "Inbox project memory suggestion"
            }
          },
          severity: "action_required",
          summary: "A memory suggestion is ready.",
          title: "Memory suggestion",
          userId: process.env.USERNAME ?? process.env.USER ?? "local-user"
        });
        await main(["node", "talon", "memory", "review-queue", "list"]);
        await main(["node", "talon", "memory", "review-queue", "accept", item.inboxId]);
      } finally {
        handle.close();
      }

      const output = logSpy.mock.calls.map((entry) => String(entry[0] ?? "")).join("\n");
      expect(output).toContain("Selected:");
      expect(output).toContain("stale");
      expect(output).toContain("Memory suggestions:");
      expect(output).toContain("Inbox ID:");
      expect(output).toContain("Inbox project memory suggestion");
    } finally {
      logSpy.mockRestore();
      process.chdir(previousCwd);
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
