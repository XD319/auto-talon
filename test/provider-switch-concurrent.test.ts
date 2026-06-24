import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "../src/runtime/bootstrap.js";
import * as providerSwitchService from "../src/runtime/operations/provider-switch-service.js";

describe("concurrent model switch", () => {
  let workspaceRoot = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-concurrent-switch-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-concurrent-switch-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    delete process.env.AGENT_PROVIDER;

    await mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ version: 1 }),
      "utf8"
    );
    await writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        currentProvider: "vendor-a",
        customProviders: {
          "vendor-a": {
            transport: "openai-compatible",
            displayName: "Vendor A",
            baseUrl: "https://vendor-a.example.test/v1",
            apiKey: "vendor-a-key",
            model: "vendor-a-model"
          },
          "vendor-b": {
            transport: "openai-compatible",
            displayName: "Vendor B",
            baseUrl: "https://vendor-b.example.test/v1",
            apiKey: "vendor-b-key",
            model: "vendor-b-model"
          }
        }
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousUserConfigDir === undefined) {
      delete process.env.AGENT_USER_CONFIG_DIR;
    } else {
      process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("rejects overlapping switchProvider calls", async () => {
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const original = providerSwitchService.switchProviderRuntime;
    vi.spyOn(providerSwitchService, "switchProviderRuntime").mockImplementation(async (input) => {
      await gate;
      return original(input);
    });

    const handle = createApplication(workspaceRoot);
    try {
      const firstSwitch = handle.service.switchProvider({
        persist: "session",
        selection: "vendor-b:vendor-b-model"
      });
      await Promise.resolve();
      const blocked = handle.service.switchProvider({
        persist: "session",
        selection: "vendor-a:vendor-a-model"
      });
      await expect(blocked).rejects.toThrow(/already in progress/i);
      releaseFirst?.();
      await firstSwitch;
    } finally {
      handle.close();
    }
  });
});
