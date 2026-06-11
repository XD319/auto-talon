import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { resolveRuntimeConfig } from "../src/runtime/runtime-config.js";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("runtime scheduler config", () => {
  it("defaults scheduler poll interval to 2000ms", () => {
    const workspace = createWorkspace();
    const config = resolveRuntimeConfig(workspace);
    expect(config.scheduler.pollIntervalMs).toBe(2_000);
  });

  it("reads scheduler.pollIntervalMs from runtime.config.json", () => {
    const workspace = createWorkspace();
    writeFileSync(
      join(workspace, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ scheduler: { pollIntervalMs: 60_000 } }),
      "utf8"
    );
    const config = resolveRuntimeConfig(workspace);
    expect(config.scheduler.pollIntervalMs).toBe(60_000);
  });
});

function createWorkspace(): string {
  const workspace = join(tmpdir(), `auto-talon-runtime-scheduler-${Date.now()}-${Math.random()}`);
  mkdirSync(join(workspace, ".auto-talon"), { recursive: true });
  tempPaths.push(workspace);
  return workspace;
}
