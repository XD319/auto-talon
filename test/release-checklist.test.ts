import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateLockfilePolicy,
  validateMigrationSchemaVersion,
  validateNodeVersionPolicy,
  validatePackageMetadata,
  validatePackContents,
  validateReleaseRepository
} from "../src/diagnostics/index.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined && existsSync(tempPath)) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("release checklist helpers", () => {
  it("recognizes this repository as the release root", () => {
    expect(validateReleaseRepository(process.cwd())).toEqual({
      details: "auto-talon repository root",
      ok: true
    });
  });

  it("rejects non-auto-talon workspaces before running release commands", () => {
    const workspace = createTempDir("auto-talon-release-other-");
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ name: "other-project" }, null, 2),
      "utf8"
    );

    const result = validateReleaseRepository(workspace);

    expect(result.ok).toBe(false);
    expect(result.details).toContain("maintainer-only");
  });

  it("requires public npm metadata", () => {
    expect(validatePackageMetadata(process.cwd())).toEqual({
      details: "public npm metadata present",
      ok: true
    });
  });

  it("requires pnpm to be the only repository lockfile", () => {
    expect(validateLockfilePolicy(process.cwd())).toEqual({
      details: "pnpm-lock.yaml is the only lockfile",
      ok: true
    });
  });

  it("requires Node.js minimum version policy to stay aligned", () => {
    expect(validateNodeVersionPolicy(process.cwd())).toEqual({
      details: "Node.js >=22.13.0 policy is consistent",
      ok: true
    });
  });

  it("validates schema version from migrations instead of local workspace state", () => {
    expect(validateMigrationSchemaVersion()).toEqual({
      details: "user_version=12, expected=12",
      ok: true
    });
  });

  it("cleans stale dist files before builds", () => {
    const stalePath = join(process.cwd(), "dist", "__stale-build-clean-test.txt");
    mkdirSync(join(process.cwd(), "dist"), { recursive: true });
    writeFileSync(stalePath, "stale\n", "utf8");

    execFileSync(process.execPath, [join(process.cwd(), "scripts", "clean-dist.mjs")], {
      cwd: process.cwd(),
      stdio: "ignore"
    });

    expect(existsSync(stalePath)).toBe(false);
  });

  it("rejects setup script Node.js version drift", () => {
    const workspace = createTempDir("auto-talon-release-node-");
    mkdirSync(join(workspace, "scripts"), { recursive: true });
    mkdirSync(join(workspace, "src", "cli"), { recursive: true });
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ engines: { node: ">=22.13.0" } }, null, 2),
      "utf8"
    );
    writeFileSync(join(workspace, "src", "cli", "bin.ts"), "const MINIMUM = '22.13.0';\n", "utf8");
    writeFileSync(join(workspace, "scripts", "setup.sh"), "echo 'Node.js >= 22.5.0 is required.'\n", "utf8");
    writeFileSync(join(workspace, "scripts", "setup.ps1"), "throw 'Node.js >= 22.5.0 is required.'\n", "utf8");

    const result = validateNodeVersionPolicy(workspace);

    expect(result.ok).toBe(false);
    expect(result.details).toContain("scripts/setup.sh must reference 22.13.0");
    expect(result.details).toContain("scripts/setup.ps1 must reference 22.13.0");
  });

  it("rejects npm lockfiles in pnpm repositories", () => {
    const workspace = createTempDir("auto-talon-release-lockfiles-");
    writeFileSync(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeFileSync(join(workspace, "package-lock.json"), "{}\n", "utf8");

    expect(validateLockfilePolicy(workspace)).toEqual({
      details: "package-lock.json is not allowed",
      ok: false
    });
  });

  it("rejects development files in the npm pack manifest", () => {
    const result = validatePackContents([
      "package.json",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "SECURITY.md",
      "dist/cli/bin.js",
      "dist/cli/index.js",
      "fixtures/runtime-smoke-tasks.json",
      "src/cli/index.ts",
      "test/release-checklist.test.ts"
    ]);

    expect(result.ok).toBe(false);
    expect(result.details).toContain("forbidden");
  });

  it("accepts release assets without smoke fixtures", () => {
    const result = validatePackContents([
      "package.json",
      "README.md",
      "SECURITY.md",
      "CHANGELOG.md",
      "LICENSE",
      "dist/cli/bin.js",
      "dist/cli/index.js"
    ]);

    expect(result).toEqual({
      details: "7 release files",
      ok: true
    });
  });
});

function createTempDir(prefix: string): string {
  const tempPath = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(tempPath);
  return tempPath;
}
