import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listConfiguredProviderEntries,
  listUserConfiguredProviderNames
} from "../src/providers/config.js";
import { listConfiguredProviders } from "../src/runtime/operations/provider-switch-service.js";

describe("global-first provider listing", () => {
  let workspaceA = "";
  let workspaceB = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;

  beforeEach(async () => {
    workspaceA = await mkdtemp(join(tmpdir(), "auto-talon-global-a-"));
    workspaceB = await mkdtemp(join(tmpdir(), "auto-talon-global-b-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-global-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_PROVIDER_API_KEY;

    await mkdir(join(workspaceA, ".auto-talon"), { recursive: true });
    await mkdir(join(workspaceB, ".auto-talon"), { recursive: true });
    await writeFile(
      join(userConfigDir, "provider.config.json"),
      JSON.stringify({
        currentProvider: "deepseek",
        customProviders: {
          deepseek: {
            transport: "openai-compatible",
            displayName: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "user-deepseek-key",
            model: "deepseek-chat"
          }
        }
      }),
      "utf8"
    );
    await writeFile(
      join(workspaceA, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ version: 1 }),
      "utf8"
    );
    await writeFile(
      join(workspaceB, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ version: 1 }),
      "utf8"
    );
  });

  afterEach(async () => {
    if (previousUserConfigDir === undefined) {
      delete process.env.AGENT_USER_CONFIG_DIR;
    } else {
      process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
    }
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("lists user-level providers from any workspace directory", () => {
    expect(listUserConfiguredProviderNames()).toEqual(["deepseek"]);
    expect(listConfiguredProviderEntries(workspaceB).map((entry) => entry.name)).toEqual(["deepseek"]);
    expect(listConfiguredProviders(workspaceB).map((entry) => entry.name)).toEqual(["deepseek"]);
  });

  it("marks workspace-only custom providers", async () => {
    await writeFile(
      join(workspaceB, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        customProviders: {
          "workspace-only": {
            transport: "openai-compatible",
            displayName: "Workspace Only",
            baseUrl: "https://workspace-only.example.test/v1",
            apiKey: "workspace-only-key",
            model: "workspace-model"
          }
        }
      }),
      "utf8"
    );

    const entries = listConfiguredProviderEntries(workspaceB);
    expect(entries.map((entry) => entry.name).sort()).toEqual(["deepseek", "workspace-only"]);
    expect(entries.find((entry) => entry.name === "deepseek")?.source).toBe("user");
    expect(entries.find((entry) => entry.name === "workspace-only")?.source).toBe("workspace-only");
  });

  it("marks workspace overrides when model differs", async () => {
    await writeFile(
      join(workspaceB, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        customProviders: {
          deepseek: {
            model: "deepseek-reasoner"
          }
        }
      }),
      "utf8"
    );

    const entry = listConfiguredProviderEntries(workspaceB).find((item) => item.name === "deepseek");
    expect(entry?.source).toBe("workspace");
    expect(listConfiguredProviders(workspaceB)[0]?.model).toBe("deepseek-reasoner");
  });
});
