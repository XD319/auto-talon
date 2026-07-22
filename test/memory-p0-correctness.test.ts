import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeMinLongTermContentLength } from "../src/policy/context-policy.js";
import { extractMemoryKeywords } from "../src/memory/memory-keywords.js";
import { RecallEngine } from "../src/recall/recall-engine.js";
import { createApplication } from "../src/runtime/index.js";
import { writeMemoryEnabled } from "../src/runtime/runtime-config.js";
import { MemoryTool } from "../src/tools/memory-tool.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) {
      rmSync(path, { force: true, recursive: true });
    }
  }
});

describe("memory P0 correctness", () => {
  it("accepts MemoryTool suggestions into persisted core memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-mem-accept-"));
    tempPaths.push(dir);
    writeMemoryEnabled(dir, true);
    const handle = createApplication(dir);
    try {
      handle.infrastructure.storage.database.exec("PRAGMA foreign_keys = OFF");
      const tool = new MemoryTool({
        enabled: () => true,
        inboxRepository: handle.infrastructure.storage.inbox,
        memoryRepository: handle.infrastructure.storage.memories
      });
      const context = {
        taskId: "task-accept-1",
        iteration: 1,
        workspaceRoot: dir,
        cwd: dir,
        userId: "u1",
        agentProfileId: "executor",
        taskMetadata: { sessionId: "s1", sourceMessageId: "m1" },
        signal: new AbortController().signal
      };
      const prepared = tool.prepare(
        {
          action: "add",
          target: "project",
          content: "Prefer TypeScript strict mode for all new files.",
          reason: "Stable project convention"
        },
        context
      ).preparedInput;
      const suggest = await tool.execute(prepared, context);
      expect(suggest.success).toBe(true);
      const inboxId = String((suggest.output as { inboxId?: string }).inboxId);
      const inbox = handle.infrastructure.storage.inbox.findById(inboxId);
      expect(inbox?.metadata.memorySuggestionDraft).toBeTruthy();
      expect(inbox?.metadata.draft).toBeUndefined();

      const accepted = handle.service.acceptMemorySuggestion(inboxId, "tester");
      expect(accepted.memory).not.toBeNull();
      expect(accepted.memory?.content).toContain("TypeScript strict");
      expect(accepted.memory?.tier).toBe("core");
      expect(accepted.inboxItem.status).toBe("done");
      expect(
        handle.service.listMemories().some((memory) => memory.content.includes("TypeScript strict"))
      ).toBe(true);
    } finally {
      handle.close();
    }
  });

  it("accepts legacy metadata.draft suggestions for backward compatibility", () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-mem-legacy-"));
    tempPaths.push(dir);
    writeMemoryEnabled(dir, true);
    const handle = createApplication(dir);
    try {
      const item = handle.infrastructure.storage.inbox.create({
        category: "memory_suggestion",
        userId: "u1",
        taskId: null,
        severity: "action_required",
        title: "add project memory",
        summary: "legacy draft key",
        bodyMd: "Use pnpm exclusively in this workspace.",
        actionHint: "review",
        dedupKey: `legacy-${Date.now()}`,
        metadata: {
          action: "add",
          target: "project",
          scopeKey: dir,
          draft: {
            confidence: 0.9,
            content: "Use pnpm exclusively in this workspace.",
            keywords: ["pnpm", "workspace"],
            metadata: {},
            privacyLevel: "internal",
            retentionPolicy: { kind: "project", reason: "legacy", ttlDays: null },
            scope: "project",
            scopeKey: dir,
            source: {
              label: "legacy",
              sourceType: "user_input",
              taskId: null,
              toolCallId: null,
              traceEventId: null
            },
            summary: "Use pnpm exclusively in this workspace.",
            title: "Use pnpm exclusively in this workspace."
          }
        }
      });
      const accepted = handle.service.acceptMemorySuggestion(item.inboxId, "tester");
      expect(accepted.memory?.content).toContain("pnpm exclusively");
    } finally {
      handle.close();
    }
  });

  it("stores CJK keywords and recalls Chinese queries with keywordScore > 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "talon-mem-cjk-"));
    tempPaths.push(dir);
    writeMemoryEnabled(dir, true);
    const handle = createApplication(dir);
    try {
      const memory = handle.service.addMemory({
        content: "本项目使用 pnpm 安装依赖，测试框架为 vitest。",
        cwd: dir,
        profileId: "executor",
        reviewerId: "tester",
        scope: "project",
        userId: "u1"
      });
      expect(memory.keywords.some((keyword) => /[\u4e00-\u9fa5]/u.test(keyword))).toBe(true);

      const pure = handle.service.addMemory({
        content: "用户偏好简洁回答，不要长篇大论。",
        cwd: dir,
        profileId: "executor",
        reviewerId: "tester",
        scope: "profile",
        userId: "u1"
      });
      expect(pure.content).toContain("简洁回答");

      const engine = new RecallEngine();
      const ranked = engine.rankMemory([memory, pure], "测试框架是什么", 5);
      const hit = ranked.find((candidate) => candidate.memory.memoryId === memory.memoryId);
      expect(hit).toBeDefined();
      expect(hit?.keywordScore ?? 0).toBeGreaterThan(0);
    } finally {
      handle.close();
    }
  });

  it("lowers the long-term write floor for CJK-heavy content", () => {
    expect(computeMinLongTermContentLength("用户偏好简洁回答")).toBe(8);
    expect(computeMinLongTermContentLength("Always use pnpm for installs.")).toBe(20);
    expect(extractMemoryKeywords("测试框架为 vitest").some((token) => token.includes("测试"))).toBe(true);
  });
});
