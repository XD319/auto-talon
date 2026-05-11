import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { runBetaReadinessCheck } from "../src/diagnostics/index.js";
import { verifyOptionalFeishuConfig } from "../src/diagnostics/beta-readiness.js";
import { hasFeishuGatewayConfig, resolveFeishuGatewayConfig } from "../src/gateway/feishu/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  delete process.env.AGENT_FEISHU_APP_ID;
  delete process.env.AGENT_FEISHU_APP_SECRET;
  delete process.env.AGENT_FEISHU_DOMAIN;

  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

describe("beta readiness", () => {
  it("returns a structured checklist with concrete gate results", async () => {
    const report = await runBetaReadinessCheck({
      minimumSuccessRate: 0.8,
      providerName: "scripted-smoke"
    });

    expect(typeof report.generatedAt).toBe("string");
    expect(Array.isArray(report.checklist)).toBe(true);
    expect(report.checklist.length).toBeGreaterThanOrEqual(6);
    expect(report.checklist.every((item) => typeof item.id === "string")).toBe(true);
    expect(report.checklist.every((item) => typeof item.ok === "boolean")).toBe(true);
    expect(report.checklist.some((item) => item.id === "provider-errors-diagnosable")).toBe(true);
    expect(report.checklist.some((item) => item.id === "external-adapter-path")).toBe(true);
  }, 40000);

  it("fails feishu shape check when config is present but invalid", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(join(workspaceRoot, ".auto-talon", "feishu.config.json"), "{invalid json", "utf8");

    const result = verifyOptionalFeishuConfig(workspaceRoot);
    expect(result.ok).toBe(false);
    expect(result.details).toContain("invalid");
  });

  it("treats default empty feishu credentials as optional", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "feishu.config.json"),
      JSON.stringify({ version: 1, appId: "", appSecret: "", domain: "feishu" }, null, 2),
      "utf8"
    );

    expect(hasFeishuGatewayConfig(workspaceRoot)).toBe(false);
    expect(verifyOptionalFeishuConfig(workspaceRoot)).toEqual({
      details: "feishu credentials not provided; adapter remains optional",
      ok: true
    });
  });

  it("lets environment credentials override empty feishu config files", async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await fs.writeFile(
      join(workspaceRoot, ".auto-talon", "feishu.config.json"),
      JSON.stringify({ version: 1, appId: "", appSecret: "", domain: "lark" }, null, 2),
      "utf8"
    );
    process.env.AGENT_FEISHU_APP_ID = "env-app";
    process.env.AGENT_FEISHU_APP_SECRET = "env-secret";

    expect(hasFeishuGatewayConfig(workspaceRoot)).toBe(true);
    expect(resolveFeishuGatewayConfig(workspaceRoot)).toEqual({
      appId: "env-app",
      appSecret: "env-secret",
      domain: "lark"
    });
    expect(verifyOptionalFeishuConfig(workspaceRoot).ok).toBe(true);
  });
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-beta-readiness-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
