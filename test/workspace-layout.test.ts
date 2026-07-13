import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findInitializedWorkspace, resolveWorkspaceLayout, workspaceIdForPath } from "../src/runtime/workspace-layout.js";

const originalUserDir = process.env.AGENT_USER_CONFIG_DIR;
const originalWorkspace = process.env.AGENT_WORKSPACE_ROOT;
afterEach(() => {
  if (originalUserDir === undefined) delete process.env.AGENT_USER_CONFIG_DIR; else process.env.AGENT_USER_CONFIG_DIR = originalUserDir;
  if (originalWorkspace === undefined) delete process.env.AGENT_WORKSPACE_ROOT; else process.env.AGENT_WORKSPACE_ROOT = originalWorkspace;
});

describe("workspace layout", () => {
  it("isolates two uninitialized directories in user-managed state", () => {
    const root = mkdtempSync(join(tmpdir(), "talon-layout-"));
    const first = join(root, "first"); const second = join(root, "second"); mkdirSync(first); mkdirSync(second);
    process.env.AGENT_USER_CONFIG_DIR = join(root, "user"); delete process.env.AGENT_WORKSPACE_ROOT;
    const a = resolveWorkspaceLayout(first); const b = resolveWorkspaceLayout(second);
    expect(a.workspaceMode).toBe("user-managed"); expect(a.workspaceRoot).toBeNull();
    expect(a.stateRoot).not.toBe(b.stateRoot); expect(a.configRoot).toBeNull();
  });

  it("discovers an initialized parent and normalizes equivalent paths", () => {
    const root = mkdtempSync(join(tmpdir(), "talon-layout-")); mkdirSync(join(root, ".auto-talon")); writeFileSync(join(root, ".auto-talon", "runtime.config.json"), "{}"); const child = join(root, "a", "b"); mkdirSync(child, { recursive: true });
    expect(findInitializedWorkspace(child)).toBe(root);
    expect(workspaceIdForPath(`${root}/`)).toBe(workspaceIdForPath(root));
  });
});
