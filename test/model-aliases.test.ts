import { describe, expect, it } from "vitest";

import {
  mergeModelAliases,
  normalizeModelAliases,
  resolveModelAlias
} from "../src/providers/model-aliases.js";
import { resolveMergedModelAliases } from "../src/providers/config.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("model aliases", () => {
  it("resolves aliases case-insensitively", () => {
    const aliases = normalizeModelAliases({
      Fav: "deepseek:deepseek-chat"
    });
    expect(resolveModelAlias("fav", aliases)).toBe("deepseek:deepseek-chat");
  });

  it("follows chained aliases", () => {
    const aliases = normalizeModelAliases({
      fav: "code",
      code: "deepseek:deepseek-chat"
    });
    expect(resolveModelAlias("fav", aliases)).toBe("deepseek:deepseek-chat");
  });

  it("rejects alias cycles", () => {
    const aliases = normalizeModelAliases({
      a: "b",
      b: "a"
    });
    expect(() => resolveModelAlias("a", aliases)).toThrow(/cycle/i);
  });
});

describe("resolveMergedModelAliases", () => {
  it("merges workspace aliases over user aliases", async () => {
    const userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-user-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-workspace-"));
    const previous = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    try {
      await mkdir(join(userConfigDir), { recursive: true });
      await writeFile(
        join(userConfigDir, "provider.config.json"),
        JSON.stringify({
          modelAliases: {
            fav: "openai:gpt-4o-mini"
          }
        }),
        "utf8"
      );
      await mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
      await writeFile(
        join(workspaceRoot, ".auto-talon", "provider.config.json"),
        JSON.stringify({
          modelAliases: {
            fav: "deepseek:deepseek-chat"
          }
        }),
        "utf8"
      );

      const merged = resolveMergedModelAliases(workspaceRoot);
      expect(merged.fav).toBe("deepseek:deepseek-chat");
      expect(mergeModelAliases({ fav: "openai:gpt-4o-mini" }, { fav: "deepseek:deepseek-chat" }).fav).toBe(
        "deepseek:deepseek-chat"
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AGENT_USER_CONFIG_DIR;
      } else {
        process.env.AGENT_USER_CONFIG_DIR = previous;
      }
      await rm(userConfigDir, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
