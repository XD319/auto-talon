import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigVersionError,
  LATEST_CONFIG_VERSION,
  migrateConfigFiles,
  validateConfigVersions
} from "../src/storage/config-migration.js";

const tempPaths: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  while (tempPaths.length > 0) {
    const workspaceRoot = tempPaths.pop();
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  }
});

describe("Config migration", () => {
  it("migrates legacy versions up to the latest config version", () => {
    const workspaceRoot = createTempWorkspace();
    const providerPath = join(workspaceRoot, ".auto-talon", "provider.config.json");
    writeJson(providerPath, {
      version: 1,
      currentProvider: "mock",
      providers: {
        mock: {
          model: "mock-default"
        }
      }
    });

    const summary = migrateConfigFiles(workspaceRoot);
    const migrated = readJson(providerPath);

    expect(summary.migratedFiles).toContain("provider.config.json");
    expect(migrated.version).toBe(LATEST_CONFIG_VERSION);
    expect(migrated.contractVersion).toBe(1);
  });

  it("throws when config version is newer than supported", () => {
    const workspaceRoot = createTempWorkspace();
    const runtimePath = join(workspaceRoot, ".auto-talon", "runtime.config.json");
    writeJson(runtimePath, {
      version: LATEST_CONFIG_VERSION + 1
    });

    expect(() => validateConfigVersions(workspaceRoot)).toThrow(ConfigVersionError);
  });

  it("throws a descriptive error for malformed json", () => {
    const workspaceRoot = createTempWorkspace();
    const gatewayPath = join(workspaceRoot, ".auto-talon", "gateway.config.json");
    writeFileSync(gatewayPath, "{not valid json", "utf8");

    expect(() => migrateConfigFiles(workspaceRoot)).toThrow(/Failed to parse gateway\.config\.json/);
  });

  it("skips missing config files gracefully", () => {
    const workspaceRoot = createTempWorkspace();
    const summary = migrateConfigFiles(workspaceRoot);
    expect(summary.migratedFiles).toHaveLength(0);
  });
});

function createTempWorkspace(): string {
  const workspaceRoot = join(tmpdir(), `auto-talon-config-migration-${Date.now()}-${Math.random()}`);
  mkdirSync(join(workspaceRoot, ".auto-talon"), { recursive: true });
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}

function writeJson(path: string, value: object): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
