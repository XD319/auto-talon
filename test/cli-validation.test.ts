import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const tempPaths: string[] = [];
const cliBin = join(process.cwd(), "src", "cli", "bin.ts");
const tsxLoader = pathToFileURL(join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;

afterEach(() => {
  delete process.env.AGENT_FEISHU_APP_ID;
  delete process.env.AGENT_FEISHU_APP_SECRET;

  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("cli validation and read-only commands", () => {
  it("does not initialize a workspace for version output", () => {
    const workspace = createTempDir("talon-version-no-init-");
    const result = runCli(workspace, ["version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("auto-talon v0.1.0");
    expect(existsSync(join(workspace, ".auto-talon"))).toBe(false);
  });

  it("rejects invalid numeric run options before touching storage", () => {
    const workspace = createTempDir("talon-invalid-number-");
    const result = runCli(workspace, ["run", "hello", "--max-iterations", "abc"]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("--max-iterations must be a positive integer");
    expect(output).not.toContain("NOT NULL constraint failed");
  });

  it("lists feishu adapter when credentials are provided through env", () => {
    const workspace = createTempDir("talon-feishu-env-");
    const result = runCli(workspace, ["gateway", "list-adapters"], {
      AGENT_FEISHU_APP_ID: "fake-app",
      AGENT_FEISHU_APP_SECRET: "fake-secret"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("feishu");
  });
});

function createTempDir(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(workspace);
  return workspace;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string> = {}
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, cliBin, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env
      }
    }
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}
