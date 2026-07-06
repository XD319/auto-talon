import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Command } from "commander";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveModelCommandCwd,
  resolveModelCommandWorkspaceFlag
} from "../src/cli/model-command.js";
import { main } from "../src/cli/index.js";

describe("model CLI workspace flag", () => {
  it("reads --workspace and --cwd from the parent model command when commander attaches them there", () => {
    const setCommand = {
      getOptionValueSource: () => "default",
      parent: {
        opts: () => ({ workspace: true, cwd: "/tmp/workspace" }),
        getOptionValueSource: (name: string) => (name === "cwd" || name === "workspace" ? "cli" : "default")
      }
    } as unknown as Command;

    expect(resolveModelCommandWorkspaceFlag({}, setCommand)).toBe(true);
    expect(resolveModelCommandCwd({}, setCommand)).toBe("/tmp/workspace");
  });
});

describe("model set --workspace persistence", () => {
  let workspaceRoot = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;
  let previousArgv: string[];

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-cli-model-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-cli-model-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    previousArgv = process.argv;
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
        currentProvider: "openai",
        providers: {
          openai: { apiKey: "user-openai-key", model: "gpt-4o-mini" },
          "xfyun-coding": {
            apiKey: "user-xfyun-key",
            baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
            model: "astron-code-latest"
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
          deepseek: {
            apiKey: "ws-deepseek-key",
            baseUrl: "https://api.deepseek.com/v1",
            model: "deepseek-v4-pro"
          },
          "xfyun-coding": {
            apiKey: "ws-xfyun-key",
            baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
            model: "astron-code-latest"
          }
        },
        customProviders: {
          deepseek: {
            transport: "openai-compatible",
            displayName: "DeepSeek",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "ws-deepseek-key",
            model: "deepseek-v4-pro"
          }
        }
      }),
      "utf8"
    );
  });

  afterEach(async () => {
    process.argv = previousArgv;
    if (previousUserConfigDir === undefined) {
      delete process.env.AGENT_USER_CONFIG_DIR;
    } else {
      process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("writes workspace provider.config.json when --workspace is passed after selection", async () => {
    process.argv = [
      "node",
      "talon",
      "model",
      "set",
      "xfyun-coding:astron-code-latest",
      "--workspace",
      "--cwd",
      workspaceRoot
    ];
    await main(process.argv);

    const workspaceConfig = JSON.parse(
      await readFile(join(workspaceRoot, ".auto-talon", "provider.config.json"), "utf8")
    ) as { currentProvider?: string };
    const userConfig = JSON.parse(
      await readFile(join(userConfigDir, "provider.config.json"), "utf8")
    ) as { currentProvider?: string };

    expect(workspaceConfig.currentProvider).toBe("xfyun-coding");
    expect(userConfig.currentProvider).toBe("openai");
  });
});
