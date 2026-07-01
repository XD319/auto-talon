import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "../src/runtime/bootstrap.js";
import { resolveProviderConfig } from "../src/providers/config.js";

describe("workspace model switch with builtin providers", () => {
  let workspaceRoot = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-ws-switch-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-ws-switch-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_PROVIDER_API_KEY;
    delete process.env.AGENT_PROVIDER_MODEL;

    await mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ version: 3 }),
      "utf8"
    );
    await writeFile(
      join(userConfigDir, "provider.config.json"),
      JSON.stringify({
        version: 3,
        currentProvider: "xfyun-coding",
        providers: {
          openai: { apiKey: "user-openai-key" },
          "xfyun-coding": {
            apiKey: "user-xfyun-key",
            baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
            model: "astron-code-latest",
            timeoutMs: 120000
          },
          deepseek: {
            apiKey: "user-deepseek-key",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-v4-pro",
            timeoutMs: 120000
          }
        }
      }),
      "utf8"
    );
    await writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify({
        version: 3,
        currentProvider: "deepseek",
        providers: {
          "xfyun-coding": {
            apiKey: "ws-xfyun-key",
            baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
            model: "astron-code-latest",
            timeoutMs: 30000
          }
        },
        customProviders: {
          deepseek: {
            transport: "openai-compatible",
            displayName: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "ws-deepseek-key",
            model: "deepseek-v4-pro",
            timeoutMs: 120000
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

  it("persists workspace switch away from deepseek customProviders override", async () => {
    expect(resolveProviderConfig(workspaceRoot).name).toBe("deepseek");

    const handle = createApplication(workspaceRoot);
    try {
      await handle.service.switchProvider({
        persist: "workspace",
        selection: "xfyun-coding:astron-code-latest"
      });
      expect(handle.service.currentProvider().name).toBe("xfyun-coding");
    } finally {
      handle.close();
    }

    const saved = JSON.parse(
      await readFile(join(workspaceRoot, ".auto-talon", "provider.config.json"), "utf8")
    ) as { currentProvider?: string };
    expect(saved.currentProvider).toBe("xfyun-coding");

    const fresh = createApplication(workspaceRoot);
    try {
      expect(fresh.service.currentProvider().name).toBe("xfyun-coding");
    } finally {
      fresh.close();
    }
  });
});
