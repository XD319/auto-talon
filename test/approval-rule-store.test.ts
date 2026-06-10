import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalRuleStore } from "../src/approvals/approval-rule-store.js";
import { buildShellPrefixPattern, matchesShellPrefixPattern } from "../src/approvals/approval-fingerprint.js";
import { buildApprovalPromptContext } from "../src/approvals/approval-prompt-view-model.js";
import type { ApprovalRecord, ToolCallRecord } from "../src/types/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await rm(tempPath, { force: true, recursive: true });
    }
  }
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-approval-test-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}

describe("approval fingerprint prefix helpers", () => {
  it("matches shell command prefixes by token", () => {
    expect(buildShellPrefixPattern("git status --short")).toEqual(["git", "status", "--short"]);
    expect(matchesShellPrefixPattern("git status", ["git", "status"])).toBe(true);
    expect(matchesShellPrefixPattern("git status --short", ["git", "status"])).toBe(true);
    expect(matchesShellPrefixPattern("git diff", ["git", "status"])).toBe(false);
  });
});

describe("approval prompt view model", () => {
  it("builds shell approval context from reason lines", () => {
    const approval: ApprovalRecord = {
      approvalId: "a1",
      allowScope: null,
      decidedAt: null,
      errorCode: null,
      expiresAt: new Date().toISOString(),
      fingerprint: "fp1",
      policyDecisionId: "p1",
      reason:
        "shell-needs-approval: Shell execution is always approval-gated.\nCommand: git status\nCWD: /tmp\nNetwork: disabled",
      requestedAt: new Date().toISOString(),
      requesterUserId: "u1",
      reviewerId: null,
      reviewerNotes: null,
      status: "pending",
      taskId: "t1",
      toolCallId: "tc1",
      toolName: "shell"
    };
    const toolCall = {
      capability: "shell.execute",
      input: { command: "git status" },
      riskLevel: "high"
    } as ToolCallRecord;

    const context = buildApprovalPromptContext(approval, toolCall);
    expect(context.summaryLine).toBe("shell: git status");
    expect(context.detailLines.some((line) => line.includes("cwd:"))).toBe(true);
  });
});

describe("approval rule store", () => {
  it("auto-approves matching shell prefix rules", async () => {
    const workspaceRoot = await createTempWorkspace();
    const store = new ApprovalRuleStore(workspaceRoot);
    store.add({
      createdAt: new Date().toISOString(),
      createdBy: "tester",
      description: "git status",
      kind: "shell_prefix",
      pattern: ["git", "status"],
      toolName: "shell"
    });

    expect(
      store.matches(
        {
          kind: "shell",
          command: "git status --short",
          cwd: workspaceRoot,
          envKeys: [],
          executable: "git",
          networkAccess: "disabled",
          pathScope: "workspace",
          timeoutMs: 1000
        },
        "shell"
      )
    ).toBe(true);
  });
});
