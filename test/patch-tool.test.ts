import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { PatchTool } from "../src/tools/patch-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("PatchTool", () => {
  it("fails update_file when target is ambiguous and replaceAll=false", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "a.txt");
    await fs.writeFile(filePath, "foo\nfoo\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "update_file",
        newText: "bar",
        path: filePath,
        replaceAll: false,
        targetText: "foo"
      },
      createContext(root)
    );
    await expect(tool.execute(prepared.preparedInput, createContext(root))).rejects.toThrow(
      /appears 2 times/i
    );
    await expect(listRollbackSnapshots(root)).resolves.toHaveLength(0);
  });

  it("supports context-aware apply_patch replacements", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "b.txt");
    await fs.writeFile(filePath, "alpha\nX\nbeta\nalpha\nX\ngamma\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "apply_patch",
        patches: [
          {
            afterContext: "\nbeta",
            beforeContext: "alpha\n",
            find: "X",
            replace: "Y",
            replaceAll: false
          }
        ],
        path: filePath
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));
    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("alpha\nY\nbeta\nalpha\nX\ngamma\n");
  });

  it("accepts oldText and newText aliases for apply_patch replacements", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "aliases.txt");
    await fs.writeFile(filePath, "const value = CONFIG.OLD_KEY;\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "apply_patch",
        patches: [
          {
            newText: "const value = CONFIG.NEW_KEY;",
            oldText: "const value = CONFIG.OLD_KEY;"
          }
        ],
        path: filePath
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("const value = CONFIG.NEW_KEY;\n");
  });

  it("includes file preview and nearest match when apply_patch target is missing", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "food.js");
    await fs.writeFile(
      filePath,
      "class Food {\n  spawn() {\n    const newPosition = { x: 1, y: 2 };\n  }\n}\n",
      "utf8"
    );
    const tool = new PatchTool(createSandbox(root));
    const prepared = tool.prepare(
      {
        action: "apply_patch",
        patches: [
          {
            find: "this.position = { x: 0, y: 0 };",
            replace: "this.position = { x: 1, y: 1 };"
          }
        ],
        path: filePath
      },
      createContext(root)
    );

    try {
      await tool.execute(prepared.preparedInput, createContext(root));
      throw new Error("Expected apply_patch to reject when the target text is missing.");
    } catch (error) {
      expect(error).toMatchObject({
        code: "tool_execution_error"
      });
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/was not found/i);
      expect(message).toContain("File head");
      expect(message).toContain("Re-read the file");
      expect(message).toMatch(/newPosition|spawn/i);
    }
    await expect(listRollbackSnapshots(root)).resolves.toHaveLength(0);
  });

  it("stores full rollback content and writes snapshot reference", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "large.txt");
    const original = "a".repeat(1_200_000);
    await fs.writeFile(filePath, original, "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "update_file",
        newText: "b",
        path: filePath,
        replaceAll: true,
        targetText: "a"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected write operation to succeed.");
    }
    const rollback = result.artifacts?.find((item) => item.artifactType === "file_rollback");
    expect(rollback).toBeDefined();
    const rollbackContent = rollback?.content as {
      originalContent: string;
      snapshotPath: string;
    };
    expect(rollbackContent.originalContent.length).toBe(original.length);
    const snapshot = await fs.readFile(rollbackContent.snapshotPath, "utf8");
    expect(snapshot.length).toBe(original.length);
  });

  it("applies unified diff patches", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "diff.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "apply_unified_diff",
        diff: [
          "--- a/diff.txt",
          "+++ b/diff.txt",
          "@@ -1,3 +1,3 @@",
          " alpha",
          "-beta",
          "+delta",
          " gamma"
        ].join("\n"),
        path: "."
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("alpha\ndelta\ngamma\n");
  });

  it("supports dry-run unified diff without writing rollback snapshots", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "dry.txt");
    await fs.writeFile(filePath, "before\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "apply_unified_diff",
        diff: ["--- a/dry.txt", "+++ b/dry.txt", "@@ -1,1 +1,1 @@", "-before", "+after"].join("\n"),
        dryRun: true,
        path: "."
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, "utf8")).toBe("before\n");
    await expect(listRollbackSnapshots(root)).resolves.toHaveLength(0);
  });

  it("renames files with rollback metadata", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const fromPath = join(root, "old.txt");
    const toPath = join(root, "nested", "new.txt");
    await fs.writeFile(fromPath, "move me\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "rename_file",
        path: "old.txt",
        toPath: "nested/new.txt"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    await expect(fs.readFile(fromPath, "utf8")).rejects.toThrow();
    expect(await fs.readFile(toPath, "utf8")).toBe("move me\n");
    await expect(listRollbackSnapshots(root)).resolves.toHaveLength(1);
  });

  it("deletes files and records rollback snapshots", async () => {
    const root = await createTempDir("auto-talon-patch-");
    const filePath = join(root, "delete.txt");
    await fs.writeFile(filePath, "remove me\n", "utf8");
    const tool = new PatchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        action: "delete_file",
        path: "delete.txt"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    await expect(fs.readFile(filePath, "utf8")).rejects.toThrow();
    await expect(listRollbackSnapshots(root)).resolves.toHaveLength(1);
  });
});

function createSandbox(workspaceRoot: string): SandboxService {
  return new SandboxService({
    workspaceRoot
  });
}

async function createTempDir(prefix: string): Promise<string> {
  const tempPath = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}

async function listRollbackSnapshots(workspaceRoot: string): Promise<string[]> {
  try {
    return await fs.readdir(join(workspaceRoot, ".auto-talon", "rollbacks"));
  } catch {
    return [];
  }
}

function createContext(workspaceRoot: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: workspaceRoot,
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-patch-test",
    userId: "test-user",
    workspaceRoot
  };
}
