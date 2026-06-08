import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("session handoff service", () => {
  it("binds a runtime session to an external gateway session", async () => {
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-handoff-"));
    tempPaths.push(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });
    try {
      const ownerUserId = "handoff-user";
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        ownerUserId,
        title: "Handoff session"
      });
      handle.service.saveSessionUiState(session.sessionId, {
        entrySource: "tui",
        messages: [{ id: "user:1", kind: "user", text: "Continue on gateway", timestamp: "2026-01-01T00:00:00.000Z" }],
        title: "Handoff session"
      });

      const result = handle.service.handoffSession({
        adapterId: "feishu",
        externalSessionId: "chat-123",
        ownerUserId,
        runtimeSessionId: session.sessionId,
        runtimeUserId: "feishu:session:chat-123",
        source: "cli"
      });

      expect(result.runtimeSessionId).toBe(session.sessionId);
      expect(result.binding.runtimeSessionId).toBe(session.sessionId);
      expect(result.resumeHint).toContain(session.sessionId);

      const rebound = handle.service.rebindGatewaySession({
        adapterId: "feishu",
        externalSessionId: "chat-123",
        ownerUserId,
        runtimeSessionId: session.sessionId,
        runtimeUserId: "feishu:session:chat-123"
      });
      expect(rebound.binding.adapterId).toBe("feishu");
    } finally {
      handle.close();
    }
  });

  it("resolves sessions by title and id prefix", async () => {
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-resolver-"));
    tempPaths.push(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });
    try {
      const ownerUserId = "resolver-user";
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        ownerUserId,
        title: "Refactor auth"
      });
      const byTitle = handle.service.resolveSessionRef("Refactor auth", ownerUserId);
      expect(byTitle.session?.sessionId).toBe(session.sessionId);
      const byPrefix = handle.service.resolveSessionRef(session.sessionId.slice(0, 8), ownerUserId);
      expect(byPrefix.session?.sessionId).toBe(session.sessionId);
    } finally {
      handle.close();
    }
  });

  it("branches a session with copied ui state", async () => {
    const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-branch-"));
    tempPaths.push(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });
    try {
      const ownerUserId = "branch-user";
      const source = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        ownerUserId,
        title: "Main line"
      });
      handle.service.saveSessionUiState(source.sessionId, {
        entrySource: "tui",
        interactionMode: "plan",
        messages: [{ id: "user:1", kind: "user", text: "Try another approach", timestamp: "2026-01-01T00:00:00.000Z" }],
        title: "Main line"
      });
      const branch = handle.service.branchSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        ownerUserId,
        sourceSessionId: source.sessionId,
        title: "Branch attempt"
      });
      const uiState = handle.service.loadSessionUiState(branch.sessionId);
      expect(uiState?.interactionMode).toBe("plan");
      expect(uiState?.messages).toHaveLength(1);
      expect(branch.title).toBe("Branch attempt");
    } finally {
      handle.close();
    }
  });
});
