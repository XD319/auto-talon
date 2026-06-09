import { describe, expect, it } from "vitest";

import {
  RecentFileReadCache,
  buildPinnedRecentFilesMessage,
  clipFileContent,
  isPinnedRecentFilesMessage,
  isVagueImplementationInput,
  splitPinnedMessages,
  syncPinnedRecentFilesMessage
} from "../src/runtime/context/recent-file-reads.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("RecentFileReadCache", () => {
  it("evicts oldest files when exceeding maxFiles", () => {
    const cache = new RecentFileReadCache({
      maxFiles: 2,
      maxBytesPerFile: 10_000,
      maxTotalBytes: 20_000,
      maxBytesPerFileUnderGuard: 10_000,
      maxTotalBytesUnderGuard: 20_000,
      toolOutputMaxTokens: 2_500
    });
    cache.record("/a.txt", "a", null);
    cache.record("/b.txt", "b", null);
    cache.record("/c.txt", "c", null);
    expect(cache.listPaths()).toEqual(["/c.txt", "/b.txt"]);
  });

  it("uses larger per-file budget in write_required mode", () => {
    const cache = new RecentFileReadCache({
      maxFiles: 1,
      maxBytesPerFile: 20,
      maxTotalBytes: 100,
      maxBytesPerFileUnderGuard: 80,
      maxTotalBytesUnderGuard: 100,
      toolOutputMaxTokens: 2_500
    });
    const longContent = "x".repeat(100);
    cache.setMode("normal");
    cache.record("/big.txt", longContent, null);
    const normalEntry = cache.list()[0];
    expect(normalEntry?.truncated).toBe(true);
    const normalBytes = normalEntry?.bytes ?? 0;

    cache.setMode("write_required");
    cache.record("/big.txt", longContent, null);
    expect(cache.list()[0]?.bytes ?? 0).toBeGreaterThan(normalBytes);
  });
});

describe("clipFileContent", () => {
  it("keeps head and tail with an elision marker", () => {
    const content = `${"a".repeat(200)}\n${"z".repeat(200)}`;
    const clipped = clipFileContent(content, 80);
    expect(clipped.truncated).toBe(true);
    expect(clipped.content).toContain("bytes elided");
    expect(clipped.content.startsWith("a")).toBe(true);
    expect(Buffer.byteLength(clipped.content, "utf8")).toBeLessThanOrEqual(80);
  });
});

describe("pinned recent file messages", () => {
  it("builds a pinned system message with file blocks", () => {
    const message = buildPinnedRecentFilesMessage([
      {
        bytes: 3,
        content: "foo",
        path: "/x.js",
        readAt: "2026-01-01T00:00:00.000Z",
        toolCallId: null,
        truncated: false
      }
    ]);
    expect(message?.metadata?.pinned).toBe(true);
    expect(message?.content).toContain("/x.js");
    expect(message?.content).toContain("foo");
  });

  it("splits and re-syncs pinned messages in the conversation array", () => {
    const pinned: ConversationMessage = {
      content: "pinned",
      metadata: {
        pinned: true,
        sourceType: "recent_file_reads"
      },
      role: "system"
    };
    const user: ConversationMessage = {
      content: "task",
      role: "user"
    };
    const { pinned: pinnedMessages, rest } = splitPinnedMessages([user, pinned]);
    expect(pinnedMessages).toHaveLength(1);
    expect(rest).toHaveLength(1);
    expect(isPinnedRecentFilesMessage(pinned)).toBe(true);

    const messages = [user];
    const cache = new RecentFileReadCache();
    cache.record("/task.js", "console.log(1);", null);
    syncPinnedRecentFilesMessage(messages, cache);
    expect(messages.some((message) => isPinnedRecentFilesMessage(message))).toBe(true);
  });
});

describe("isVagueImplementationInput", () => {
  it("detects short fix-bug prompts", () => {
    expect(isVagueImplementationInput("修复这个bug")).toBe(true);
    expect(isVagueImplementationInput("fix this bug")).toBe(true);
    expect(
      isVagueImplementationInput(
        "Implement the missing snake game difficulty selector and wire it to CONFIG in game.js"
      )
    ).toBe(false);
  });
});
