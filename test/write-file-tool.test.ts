import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { WriteFileTool } from "../src/tools/write-file-tool.js";
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

describe("WriteFileTool", () => {
  it("does not create rollback snapshots when write_file fails with overwrite=false", async () => {
    const root = await createTempDir("auto-talon-write-file-");
    const filePath = join(root, "existing.txt");
    await fs.writeFile(filePath, "original\n", "utf8");
    const tool = new WriteFileTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        content: "replacement\n",
        overwrite: false,
        path: filePath
      },
      createContext(root)
    );

    await expect(tool.execute(prepared.preparedInput, createContext(root))).rejects.toThrow(
      /overwrite=false/i
    );
    await expect(listRollbackSnapshots(root)).resolves.toHaveLength(0);
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
    taskId: "task-write-file-test",
    userId: "test-user",
    workspaceRoot
  };
}
