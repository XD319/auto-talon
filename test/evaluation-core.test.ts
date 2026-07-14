import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareEvalReports,
  evalSuiteManifestSchema,
  loadEvalSuite,
  passAtK,
  passPowerK,
  runCapabilityEval,
  wilsonInterval,
  writeEvalArtifacts,
  type EvalRunReport
} from "../src/evaluation/public.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";
import { runSmokeSuite } from "../src/testing/index.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path !== undefined) await fs.rm(path, { force: true, recursive: true });
  }
});

describe("evaluation core", () => {
  it("loads the versioned thirty-task blind suite", () => {
    const suite = loadEvalSuite("fixtures/eval-suites/internal-blind.v1.json");
    expect(suite.schemaVersion).toBe(1);
    expect(suite.tasks).toHaveLength(30);
    expect(new Set(suite.tasks.map((task) => task.id)).size).toBe(30);
    expect(suite.tasks.every((task) => task.scorers.some((scorer) => scorer.required && scorer.type !== "llm_judge"))).toBe(true);
  });

  it("rejects duplicate tasks and judge-only grading", () => {
    const task = {
      capabilities: ["answer"],
      category: "test",
      id: "duplicate",
      input: "answer",
      scorers: [{ id: "judge", required: false, rubric: "good", type: "llm_judge" }],
      title: "Duplicate"
    };
    expect(() => evalSuiteManifestSchema.parse({
      description: "invalid",
      id: "invalid",
      schemaVersion: 1,
      tasks: [task, task],
      version: "1"
    })).toThrow(/deterministic|required|unique/i);
    expect(() => evalSuiteManifestSchema.parse({
      description: "invalid",
      id: "invalid",
      schemaVersion: 1,
      tasks: [],
      unexpected: true,
      version: "1"
    })).toThrow();
  });

  it("computes reliability and confidence metrics", () => {
    expect(passAtK(2, 3, 3)).toBe(1);
    expect(passPowerK(2, 3, 3)).toBeCloseTo(8 / 27);
    const interval = wilsonInterval(8, 10);
    expect(interval.low).toBeLessThan(0.8);
    expect(interval.high).toBeGreaterThan(0.8);
  });

  it("runs blind repetitions without leaking fixture identity or graders", async () => {
    const root = await makeTempDirectory("eval-suite-");
    const suitePath = join(root, "suite.json");
    await fs.writeFile(suitePath, JSON.stringify({
      description: "test suite",
      id: "blind-test",
      schemaVersion: 1,
      tasks: [{
        capabilities: ["answer"],
        category: "test",
        id: "secret-fixture-id",
        input: "Reply READY",
        scorers: [{ contains: ["READY"], id: "secret-scorer", type: "output" }],
        title: "Blind answer"
      }],
      version: "1"
    }), "utf8");
    const observed: ProviderInput[] = [];
    const report = await runCapabilityEval({
      configCwd: process.cwd(),
      providerFactory: () => new FinalProvider(observed),
      providerName: "test-provider",
      repetitions: 3,
      suitePath
    });
    expect(report.gate.passed).toBe(true);
    expect(report.metrics.successRate).toBe(1);
    expect(report.tasks[0]?.trials).toHaveLength(3);
    expect(observed).toHaveLength(3);
    for (const input of observed) {
      expect(input.task.taskId).not.toBe("secret-fixture-id");
      expect(JSON.stringify(input.task.metadata)).not.toContain("secret-scorer");
      expect(JSON.stringify(input.messages)).not.toContain("secret-fixture-id");
    }
  });

  it("compares baselines and writes machine-readable artifacts", async () => {
    const baseline = reportFixture({ duration: 100, passPowerK: 1, successRate: 1 });
    const current = reportFixture({ duration: 140, passPowerK: 0.8, successRate: 0.9 });
    const comparison = compareEvalReports(current, baseline);
    expect(comparison.failed).toBe(true);
    expect(comparison.warnings).toEqual([expect.stringContaining("p95")]);
    const output = await makeTempDirectory("eval-artifacts-");
    const paths = await writeEvalArtifacts(baseline, output);
    expect(await fs.readFile(paths.jsonPath, "utf8")).toContain("blind-test");
    expect(await fs.readFile(paths.junitPath, "utf8")).toContain("testsuite");
  });

  it("fails fast for unknown smoke task ids", async () => {
    await expect(runSmokeSuite({ providerName: "scripted-smoke", taskIds: ["missing-task"] }))
      .rejects.toThrow(/Unknown smoke task ids/);
  });
});

class FinalProvider implements Provider {
  public readonly name = "blind-test-provider";
  public readonly model = "blind-test-model";

  public constructor(private readonly observed: ProviderInput[]) {}

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    this.observed.push(input);
    return Promise.resolve({
      kind: "final",
      message: "READY",
      usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 }
    });
  }
}

async function makeTempDirectory(prefix: string): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

function reportFixture(input: { duration: number; passPowerK: number; successRate: number }): EvalRunReport {
  return {
    gate: { passed: true, reasons: [] },
    manifest: {
      codeSha: "abc",
      datasetSha256: "dataset",
      generatedAt: "2026-01-01T00:00:00.000Z",
      modelName: "model",
      nodeVersion: process.version,
      platform: process.platform,
      promptVersion: "1",
      providerName: "provider",
      repetitions: 1,
      suiteId: "blind-test",
      suiteVersion: "1",
      toolSchemaVersion: "1"
    },
    metrics: {
      averageRounds: 1,
      averageToolCalls: 0,
      durationMs: { p50: input.duration, p95: input.duration },
      passAtK: input.successRate,
      costUsd: { available: false, average: null, total: null },
      passPowerK: input.passPowerK,
      standardError: 0,
      successRate: input.successRate,
      successRate95: { high: 1, low: 0 },
      tokenUsage: { available: true, cachedInputTokens: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2 }
    },
    suite: { description: "test", id: "blind-test", version: "1" },
    tasks: []
  };
}
