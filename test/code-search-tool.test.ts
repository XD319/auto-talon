import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxService } from "../src/sandbox/sandbox-service.js";
import { CodeSearchTool } from "../src/tools/code-search-tool.js";
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

describe("CodeSearchTool", () => {
  it("searches content with regex, glob filters, and context lines", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.mkdir(join(root, "docs"), { recursive: true });
    await fs.writeFile(join(root, "src", "app.ts"), "alpha\nconst answer = 42;\nomega\n", "utf8");
    await fs.writeFile(join(root, "docs", "app.md"), "const answer = 42;\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        contextLines: 1,
        includeGlobs: ["src/**/*.ts"],
        query: "answer\\s*=\\s*\\d+",
        regex: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected code_search to succeed.");
    }
    const output = result.output as {
      matches: Array<{
        afterContext: string[];
        beforeContext: string[];
        lineNumber: number;
        relativePath: string;
      }>;
    };
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]).toMatchObject({
      afterContext: ["omega"],
      beforeContext: ["alpha"],
      lineNumber: 2,
      relativePath: "src/app.ts"
    });
  });

  it("searches filenames and excludes ignored directories", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.mkdir(join(root, "node_modules"), { recursive: true });
    await fs.writeFile(join(root, "src", "feature-target.ts"), "no content hit\n", "utf8");
    await fs.writeFile(join(root, "node_modules", "feature-target.ts"), "ignored\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        query: "feature-target",
        searchFilenames: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected filename search to succeed.");
    }
    const output = result.output as {
      filenameMatches: Array<{ relativePath: string }>;
    };
    expect(output.filenameMatches).toEqual([{ relativePath: "src/feature-target.ts", path: join(root, "src", "feature-target.ts") }]);
  });

  it("returns a validation failure for invalid regex patterns", async () => {
    const root = await createTempDir("auto-talon-code-search-");
    await fs.writeFile(join(root, "app.ts"), "content\n", "utf8");
    const tool = new CodeSearchTool(createSandbox(root));

    const prepared = tool.prepare(
      {
        query: "[",
        regex: true
      },
      createContext(root)
    );
    const result = await tool.execute(prepared.preparedInput, createContext(root));

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid regex to fail.");
    }
    expect(result.errorCode).toBe("tool_validation_error");
    expect(result.errorMessage).toContain("Invalid regex");
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
    taskId: "task-code-search-test",
    userId: "test-user",
    workspaceRoot
  };
}
