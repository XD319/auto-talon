import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { ReadFileTool } from "../src/tools/read-file-tool.js";
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

describe("ReadFileTool", () => {
  it("supports offset+limit for read_file", async () => {
    const root = await createTempDir("auto-talon-read-file-");
    const filePath = join(root, "a.txt");
    await fs.writeFile(filePath, "l1\nl2\nl3\nl4\n", "utf8");
    const tool = new ReadFileTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        limit: 2,
        offset: 1,
        path: filePath
      },
      createContext(root)
    );

    const result = await tool.execute(prepared.preparedInput, createContext(root));
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected read_file to succeed.");
    }
    const output = result.output as { content: string; endLine: number };
    expect(output.content).toBe("l2\nl3");
    expect(output.endLine).toBe(3);
  });

  it("returns a validation error when read_file targets a directory", async () => {
    const root = await createTempDir("auto-talon-read-file-");
    const tool = new ReadFileTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        path: root
      },
      createContext(root)
    );

    const result = await tool.execute(prepared.preparedInput, createContext(root));
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected read_file on a directory to fail validation.");
    }
    expect(result.errorCode).toBe("tool_validation_error");
    expect(result.errorMessage).toContain("glob");
    expect(result.details).toMatchObject({
      path: root,
      suggestedTool: "glob"
    });
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

function createContext(workspaceRoot: string): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: workspaceRoot,
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-read-file-test",
    userId: "test-user",
    workspaceRoot
  };
}
