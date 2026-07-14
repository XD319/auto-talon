import { describe, expect, it } from "vitest";

import { runCodingEvalReport, runEvalReport } from "../src/diagnostics/index.js";
import { loadSmokeTaskFixtures } from "../src/testing/index.js";

describe("eval report", () => {
  it("generates the minimal aggregate report for fixed task samples", async () => {
    const report = await runEvalReport({
      providerName: "scripted-smoke"
    });

    expect(report.providerName).toBe("scripted-smoke");
    expect(report.taskCount).toBeGreaterThanOrEqual(10);
    expect(report.successRate).toBeGreaterThan(0.9);
    expect(report.averageDurationMs).toBeGreaterThanOrEqual(0);
    expect(report.averageRounds).toBeGreaterThan(0);
    expect(typeof report.failureReasonDistribution).toBe("object");
    expect(Object.keys(report.categorySuccessRates)).toContain("multi_turn_execution");
    expect(report.categorySuccessRates.multi_turn_execution?.successRate).toBeGreaterThan(0.9);
    expect(report.tokenUsage.available).toBe(true);
    expect(report.tokenUsage.totalTokens).toBeGreaterThan(0);
    expect(Array.isArray(report.typicalFailures)).toBe(true);
  }, 30000);

  it("explains missing default fixtures for installed-package diagnostics", () => {
    expect(() => loadSmokeTaskFixtures("missing-fixtures/runtime-smoke-tasks.json")).toThrow(
      /maintainer validation assets/
    );
  });

  it("generates a coding-focused eval report with verification gate metrics", async () => {
    const report = await runCodingEvalReport({
      providerName: "scripted-smoke"
    });

    expect(report.providerName).toBe("scripted-smoke");
    expect(report.taskCount).toBeGreaterThanOrEqual(5);
    expect(report.successRate).toBeGreaterThanOrEqual(0.8);
    expect(report.verificationRate).toBe(1);
    expect(report.toolFailureRate).toBeGreaterThanOrEqual(0);
    expect(report.gitReadyDiffRate).toBe(0);
    expect(report.unverifiedMutationTasks).toEqual([]);
    expect(report.betaGate.passed).toBe(true);
  }, 30000);
});
