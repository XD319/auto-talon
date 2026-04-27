import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { McpClientManager } from "../src/mcp/index.js";

describe("McpClientManager", () => {
  it("discovers configured mcp tools with runtime-safe naming", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-mcp-"));
    try {
      mkdirSync(join(workspace, ".auto-talon"), { recursive: true });
      const serverScript = resolve(process.cwd(), "test", "fixtures", "mcp-fake-server.js");
      writeFileSync(
        join(workspace, ".auto-talon", "mcp.config.json"),
        `${JSON.stringify(
          {
            servers: [
              {
                args: [serverScript],
                command: process.execPath,
                env: {},
                id: "fake",
                privacyLevel: "internal",
                riskLevel: "high"
              }
            ]
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const manager = new McpClientManager(workspace);
      const tools = manager.discover();
      expect(tools.some((tool) => tool.name === "mcp__fake__echo")).toBe(true);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("reports discovery error when a configured server cannot list tools", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-mcp-"));
    try {
      mkdirSync(join(workspace, ".auto-talon"), { recursive: true });
      writeFileSync(
        join(workspace, ".auto-talon", "mcp.config.json"),
        `${JSON.stringify(
          {
            servers: [
              {
                args: ["missing-server-script.js"],
                command: process.execPath,
                env: {},
                id: "broken",
                privacyLevel: "internal",
                riskLevel: "high"
              }
            ]
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const manager = new McpClientManager(workspace);
      expect(manager.discover()).toHaveLength(0);
      const servers = await manager.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0]?.id).toBe("broken");
      expect(servers[0]?.discoveryError).not.toBeNull();
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
