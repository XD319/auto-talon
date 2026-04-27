import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { runBetaReadinessCheck } from "../src/diagnostics/index.js";
import { verifyOptionalFeishuConfig } from "../src/diagnostics/beta-readiness.js";

const tempPaths: string[] = [];

afterEach(async () => {
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
});

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-beta-readiness-"));
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
