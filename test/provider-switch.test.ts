import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "../src/runtime/bootstrap.js";
import { resolveProviderConfigForSwitch } from "../src/providers/config.js";
import {
  formatProviderSelection,
  isProviderSwitchable,
  listConfiguredProviders
} from "../src/runtime/operations/provider-switch-service.js";

describe("provider switch service", () => {
  let workspaceRoot = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-switch-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-switch-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_PROVIDER_API_KEY;
    delete process.env.AGENT_PROVIDER_MODEL;
    delete process.env.AGENT_PROVIDER_BASE_URL;

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
    if (previousUserConfigDir === undefined) {
      delete process.env.AGENT_USER_CONFIG_DIR;
    } else {
      process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("lists only configured custom providers", () => {
    const configured = listConfiguredProviders(workspaceRoot);
    expect(configured.map((entry) => entry.name).sort()).toEqual(["vendor-a", "vendor-b"]);
  });

  it("resolves switch config without env overrides", () => {
    process.env.AGENT_PROVIDER_MODEL = "env-model";
    const resolved = resolveProviderConfigForSwitch(workspaceRoot, "vendor-b:vendor-b-model");
    expect(resolved.name).toBe("vendor-b");
    expect(resolved.model).toBe("vendor-b-model");
    expect(isProviderSwitchable(resolved)).toBe(true);
    expect(formatProviderSelection(resolved)).toBe("vendor-b:vendor-b-model");
  });

  it("switches provider at runtime through application service", async () => {
    const handle = createApplication(workspaceRoot);
    try {
      expect(handle.service.currentProvider().name).toBe("vendor-a");
      const result = await handle.service.switchProvider({
        persist: "session",
        selection: "vendor-b:vendor-b-model"
      });
      expect(result.providerConfig.name).toBe("vendor-b");
      expect(handle.service.currentProvider().model).toBe("vendor-b-model");
    } finally {
      handle.close();
    }
  });
});
