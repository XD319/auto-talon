import type { TraceEvent } from "../types/index.js";
import type { EvalSuiteManifest, EvalTask } from "./schema.js";

export interface EvalScorerResult {
  evidence: string;
  id: string;
  passed: boolean;
  required: boolean;
  score: number;
  type: string;
}

export interface EvalTrialResult {
  changedPaths: string[];
  costUsd: number | null;
  durationMs: number;
  output: string | null;
  rounds: number;
  scorerResults: EvalScorerResult[];
  success: boolean;
  taskId: string;
  tokenUsage: {
    cachedInputTokens: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  toolCallCount: number;
  traceEventCount: number;
  trace: TraceEvent[];
  trial: number;
}

export interface EvalTaskResult {
  passAtK: number;
  passPowerK: number;
  successRate: number;
  task: Pick<EvalTask, "id" | "title" | "category" | "difficulty" | "risk" | "capabilities">;
  trials: EvalTrialResult[];
}

export interface EvalRunManifest {
  codeSha: string | null;
  datasetSha256: string;
  generatedAt: string;
  modelName: string | null;
  nodeVersion: string;
  platform: string;
  promptVersion: string;
  providerName: string;
  repetitions: number;
  suiteId: string;
  suiteVersion: string;
  toolSchemaVersion: string;
}

export interface EvalRunReport {
  gate: {
    passed: boolean;
    reasons: string[];
  };
  manifest: EvalRunManifest;
  metrics: {
    averageRounds: number;
    costUsd: { available: boolean; average: number | null; total: number | null };
    averageToolCalls: number;
    durationMs: { p50: number; p95: number };
    passAtK: number;
    passPowerK: number;
    standardError: number;
    successRate: number;
    successRate95: { high: number; low: number };
    tokenUsage: EvalTrialResult["tokenUsage"] & { available: boolean };
  };
  suite: Pick<EvalSuiteManifest, "id" | "version" | "description">;
  tasks: EvalTaskResult[];
}
