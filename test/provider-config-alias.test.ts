import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { useProviderConfig } from "../src/providers/config.js";

describe("provider config alias persistence", () => {
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;

  beforeEach(async () => {
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-alias-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    await mkdir(userConfigDir, { recursive: true });
    await writeFile(
      join(userConfigDir, "provider.config.json"),
      JSON.stringify(
        {
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
          },
          modelAliases: {
            fav: "vendor-b:vendor-b-model"
          }
        },
        null,
        2
      ),
      "utf8"
    );
  });

  afterEach(async () => {
    if (previousUserConfigDir === undefined) {
      delete process.env.AGENT_USER_CONFIG_DIR;
    } else {
      process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
    }
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("writes the resolved provider name when switching with an alias", async () => {
    const result = useProviderConfig("fav", { scope: "user" });
    expect(result.providerName).toBe("vendor-b");

    const saved = JSON.parse(
      await readFile(join(userConfigDir, "provider.config.json"), "utf8")
    ) as {
      currentProvider: string;
      providers: Record<string, { model?: string }>;
    };
    expect(saved.currentProvider).toBe("vendor-b");
    expect(saved.providers["vendor-b"]?.model).toBe("vendor-b-model");
  });
});
