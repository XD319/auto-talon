import type { EvalRunReport } from "./types.js";

export interface EvalBaselineComparison {
  failed: boolean;
  failures: string[];
  warnings: string[];
  deltas: {
    passPowerK: number;
    successRate: number;
    costAverageRatio: number | null;
    durationP95Ratio: number | null;
  };
}

export interface EvalBaselineThresholds {
  maxDurationP95IncreaseRatio?: number;
  maxPassPowerKDrop?: number;
  maxSuccessRateDrop?: number;
  maxCostIncreaseRatio?: number;
}

export function compareEvalReports(
  current: EvalRunReport,
  baseline: EvalRunReport,
  thresholds: EvalBaselineThresholds = {}
): EvalBaselineComparison {
  if (current.manifest.suiteId !== baseline.manifest.suiteId) {
    throw new Error(`Cannot compare different eval suites: ${current.manifest.suiteId} vs ${baseline.manifest.suiteId}.`);
  }
  const maxSuccessRateDrop = thresholds.maxSuccessRateDrop ?? 0.05;
  const maxPassPowerKDrop = thresholds.maxPassPowerKDrop ?? 0.1;
  const maxDurationP95IncreaseRatio = thresholds.maxDurationP95IncreaseRatio ?? 0.25;
  const successRateDelta = current.metrics.successRate - baseline.metrics.successRate;
  const maxCostIncreaseRatio = thresholds.maxCostIncreaseRatio ?? 0.25;
  const passPowerKDelta = current.metrics.passPowerK - baseline.metrics.passPowerK;
  const durationP95Ratio = baseline.metrics.durationMs.p95 > 0
    ? current.metrics.durationMs.p95 / baseline.metrics.durationMs.p95 - 1
    : null;
  const failures: string[] = [];
  const baselineAverageCost = baseline.metrics.costUsd?.average ?? null;
  const currentAverageCost = current.metrics.costUsd?.average ?? null;
  const costAverageRatio = baselineAverageCost !== null && baselineAverageCost > 0 && currentAverageCost !== null
    ? currentAverageCost / baselineAverageCost - 1
    : null;
  const warnings: string[] = [];

  if (!current.gate.passed) failures.push(...current.gate.reasons.map((reason) => `required scorer failed: ${reason}`));
  if (successRateDelta < -maxSuccessRateDrop) failures.push(`success rate dropped ${(Math.abs(successRateDelta) * 100).toFixed(1)}pp`);
  if (passPowerKDelta < -maxPassPowerKDrop) failures.push(`pass^k dropped ${(Math.abs(passPowerKDelta) * 100).toFixed(1)}pp`);
  if (durationP95Ratio !== null && durationP95Ratio > maxDurationP95IncreaseRatio) {
    warnings.push(`p95 duration increased ${(durationP95Ratio * 100).toFixed(1)}%`);
  }
  if (costAverageRatio !== null && costAverageRatio > maxCostIncreaseRatio) {
    warnings.push(`average cost increased ${(costAverageRatio * 100).toFixed(1)}%`);
  }
  const baselineTaskIds = new Set(baseline.tasks.map((task) => task.task.id));
  for (const task of current.tasks.filter((item) => !baselineTaskIds.has(item.task.id))) {
    if (task.successRate < 1) failures.push(`new task is not fully passing: ${task.task.id}`);
  }
  return {
    deltas: { costAverageRatio, durationP95Ratio, passPowerK: passPowerKDelta, successRate: successRateDelta },
    failed: failures.length > 0,
    failures,
    warnings
  };
}
