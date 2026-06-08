import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { GlobTool } from "../src/tools/glob-tool.js";
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

describe("GlobTool", () => {
  it("lists directory entries when no pattern is provided", async () => {
    const root = await createTempDir("auto-talon-glob-");
    await fs.writeFile(join(root, "alpha.txt"), "a\n", "utf8");
    await fs.mkdir(join(root, "nested"), { recursive: true });
    const tool = new GlobTool(createSandbox(root));

    const prepared = tool.prepare({ path: root }, createContext(root));
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    const output = result.output as {
      entries: Array<{ name: string; type: string }>;
    };
    expect(output.entries.map((entry) => entry.name).sort()).toEqual(["alpha.txt", "nested"]);
  });

  it("finds files matching a glob pattern recursively", async () => {
    const root = await createTempDir("auto-talon-glob-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "src", "app.ts"), "export {}\n", "utf8");
    await fs.writeFile(join(root, "src", "app.test.ts"), "test\n", "utf8");
    await fs.writeFile(join(root, "node_modules", "skip.ts"), "skip\n", "utf8");
    const tool = new GlobTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        path: root,
        pattern: "**/*.ts"
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    const output = result.output as {
      matches: Array<{ path: string; type: string }>;
    };
    const paths = output.matches.map((match) => match.path).sort();
    expect(paths).toEqual([join(root, "src", "app.test.ts"), join(root, "src", "app.ts")]);
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
    taskId: "task-glob-test",
    userId: "test-user",
    workspaceRoot
  };
}
