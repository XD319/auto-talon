/**
 * Governed vs ablated A/B on the same suite and provider.
 *
 * governed — product defaults.
 * comprehensive-ablation — compaction off, tool-result pruning off, recall/memory/repo map/
 *            promotion/experience/completion verification/file-read cache off.
 *
 * Usage:
 *   node --import tsx scripts/benchmark-ablation-eval.ts --provider <name>
 * Optional:
 *   --suite <path>       default fixtures/eval-suites/internal-blind.v2.json
 *   --repetitions <n>    default 1
 *   --output <dir>       default eval-artifacts/ablation
 *   --tasks <id,id,...>
 *   --arm <governed|comprehensive-ablation|memory-off|compact-off|completion-verification-off>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runCapabilityEval, type EvalRunReport } from "../src/evaluation/index.js";
import { resolveAppConfig } from "../src/runtime/index.js";
import type { AppConfig } from "../src/runtime/index.js";

const DEFAULT_SUITE = "fixtures/eval-suites/internal-blind.v2.json";
const DEFAULT_OUTPUT = "eval-artifacts/ablation";

const COMPACT_OFF: Partial<AppConfig["compact"]> = {
  iterationThreshold: 1_000_000_000,
  messageThreshold: 1_000_000_000,
  minTokenPressureRatio: 0,
  summarizer: "deterministic",
  tokenThreshold: 1_000_000_000,
  toolCallThreshold: 1_000_000_000
};

const ABLATED: Partial<AppConfig> = {
  compact: COMPACT_OFF as AppConfig["compact"],
  contextRetention: {
    fileReadCacheEnabled: false,
    maxBytesPerFile: 1_000_000,
    maxBytesPerFileUnderGuard: 1_000_000,
    maxFiles: 64,
    maxTotalBytes: 4_000_000,
    maxTotalBytesUnderGuard: 4_000_000,
    toolOutputMaxTokens: 1_000_000,
    toolResultKeepGroups: 1_000_000
  },
  experience: { enabled: false },
  memory: { enabled: false } as AppConfig["memory"],
  promotion: { enabled: false } as AppConfig["promotion"],
  recall: { budgetRatio: 0, enabled: false, maxCandidatesPerScope: 1 },
  workflow: {
    completionVerification: { enabled: false },
    repoMap: { enabled: false }
  } as AppConfig["workflow"]
};

interface ArmDef {
  configOverride?: Partial<AppConfig>;
  dir: string;
  label: string;
}

const ARMS: ArmDef[] = [
  { dir: "governed", label: "governed" },
  { configOverride: ABLATED, dir: "comprehensive-ablation", label: "comprehensive-ablation" },
  { configOverride: { memory: { enabled: false } as AppConfig["memory"] }, dir: "memory-off", label: "memory-off" },
  { configOverride: { compact: COMPACT_OFF as AppConfig["compact"] }, dir: "compact-off", label: "compact-off" },
  { configOverride: { workflow: { completionVerification: { enabled: false } } as AppConfig["workflow"] }, dir: "completion-verification-off", label: "completion-verification-off" }
];

interface CliOptions {
  arm: string | null;
  help: boolean;
  maxCostUsd: number | null;
  output: string;
  provider: string | null;
  repetitions: number;
  suite: string;
  taskIds: string[];
}

function printHelp(): void {
  console.log(`Usage:
  node --import tsx scripts/benchmark-ablation-eval.ts --provider <name> [options]

Options:
  --provider <name>       Required
  --suite <path>          Eval suite (default: ${DEFAULT_SUITE})
  --repetitions <n>       Trials per task (default: 1)
  --output <dir>          Output directory (default: ${DEFAULT_OUTPUT})
  --tasks <id,id,...>     Optional task subset
  --max-cost-usd <n>      Required total API spend cap across arms
  --arm <governed|comprehensive-ablation|memory-off|compact-off|completion-verification-off>
  --help`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    arm: null,
    help: false,
    maxCostUsd: null,
    output: DEFAULT_OUTPUT,
    provider: null,
    repetitions: 1,
    suite: DEFAULT_SUITE,
    taskIds: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--help":
        options.help = true;
        break;
      case "--provider":
        if (next === undefined) throw new Error("--provider requires a value");
        options.provider = next;
        i += 1;
        break;
      case "--suite":
        if (next === undefined) throw new Error("--suite requires a value");
        options.suite = next;
        i += 1;
        break;
      case "--repetitions":
        if (next === undefined) throw new Error("--repetitions requires a value");
        options.repetitions = Number.parseInt(next, 10);
        if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
          throw new Error("--repetitions must be a positive integer");
        }
        i += 1;
        break;
      case "--output":
        if (next === undefined) throw new Error("--output requires a value");
        options.output = next;
        i += 1;
        break;
      case "--tasks":
        if (next === undefined) throw new Error("--tasks requires a value");
        options.taskIds = next.split(",").map((value) => value.trim()).filter(Boolean);
        i += 1;
        break;
      case "--arm":
        if (next === undefined) throw new Error("--arm requires a value");
        options.arm = next;
        i += 1;
        break;
      case "--max-cost-usd":
        if (next === undefined) throw new Error("--max-cost-usd requires a value");
        options.maxCostUsd = Number(next);
        if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) throw new Error("--max-cost-usd must be positive");
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function summarizeArm(label: string, report: EvalRunReport) {
  return {
    averageRounds: report.metrics.averageRounds,
    averageToolCalls: report.metrics.averageToolCalls,
    gatePassed: report.gate.passed,
    inputTokens: report.metrics.tokenUsage.inputTokens,
    label,
    passAtK: report.metrics.passAtK,
    successRate: report.metrics.successRate,
    totalTokens: report.metrics.tokenUsage.totalTokens
  };
}

function pairedDeltas(product: EvalRunReport, control: EvalRunReport) {
  const controlTrials = new Map(control.tasks.flatMap((task) => task.trials.map((trial) =>
    [`${task.task.id}:${trial.trial}`, trial] as const)));
  const pairs = product.tasks.flatMap((task) => task.trials.flatMap((trial) => {
    const other = controlTrials.get(`${task.task.id}:${trial.trial}`);
    const invalid = new Set(["harness_error", "provider_configuration_failure", "environment_failure"]);
    if (other === undefined || invalid.has(trial.failureClassification ?? "") || invalid.has(other.failureClassification ?? "")) return [];
    return [{ taskId: task.task.id, trial: trial.trial,
      rounds: trial.rounds - other.rounds,
      toolCalls: trial.toolCallCount - other.toolCallCount,
      tokens: trial.tokenUsage.totalTokens - other.tokenUsage.totalTokens,
      success: Number(trial.success) - Number(other.success) }];
  }));
  const interval = (values: number[]) => {
    const n = values.length;
    if (n === 0) return { n, mean: null, ci95: null };
    const mean = values.reduce((a, b) => a + b, 0) / n;
    if (n < 2) return { n, mean, ci95: null };
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
    const critical = n <= 30
      ? [0, 0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
          2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
          2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045][n]!
      : 1.96;
    const margin = critical * Math.sqrt(variance / n);
    return { n, mean, ci95: [mean - margin, mean + margin] };
  };
  return { direction: "product_minus_control", pairs,
    rounds: interval(pairs.map((pair) => pair.rounds)),
    toolCalls: interval(pairs.map((pair) => pair.toolCalls)),
    tokens: interval(pairs.map((pair) => pair.tokens)),
    success: interval(pairs.map((pair) => pair.success)) };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.provider === null || options.provider.trim() === "") {
    printHelp();
    throw new Error("--provider is required");
  }
  if (options.maxCostUsd === null) throw new Error("--max-cost-usd is required for a paid A/B run");
  const armDefs = options.arm === null
    ? ARMS.filter((arm) => ["governed", "comprehensive-ablation"].includes(arm.label))
    : ARMS.filter((arm) => arm.label === options.arm);
  if (armDefs.length === 0) {
    throw new Error(`Unknown --arm "${options.arm}".`);
  }

  const outputRoot = resolve(options.output);
  const common = {
    providerName: options.provider,
    repetitions: options.repetitions,
    suitePath: options.suite,
    ...(options.taskIds.length > 0 ? { taskIds: options.taskIds } : {})
  };
  const summaries: Record<string, ReturnType<typeof summarizeArm>> = {};
  const reports: Record<string, EvalRunReport> = {};
  const armConfigs: Record<string, unknown> = {};
  const baseConfig = resolveAppConfig();
  let cumulativeCostUsd = 0;
  for (const arm of armDefs) {
    const armDir = join(outputRoot, arm.dir);
    mkdirSync(armDir, { recursive: true });
    console.error(`Running ${arm.label} against ${options.suite}...`);
    const report = await runCapabilityEval({
      ...common,
      ...(arm.configOverride !== undefined ? { configOverride: arm.configOverride } : {}),
      maxCostUsd: options.maxCostUsd - cumulativeCostUsd,
      resumeDirectory: armDir
    });
    writeFileSync(join(armDir, "eval-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const armConfig = {
      arm: arm.label,
      effectiveConfig: {
        compact: { ...baseConfig.compact, ...arm.configOverride?.compact },
        contextRetention: { ...baseConfig.contextRetention, ...arm.configOverride?.contextRetention },
        memory: { ...baseConfig.memory, ...arm.configOverride?.memory },
        recall: { ...baseConfig.recall, ...arm.configOverride?.recall },
        promotion: { ...baseConfig.promotion, ...arm.configOverride?.promotion },
        experience: { ...baseConfig.experience, ...arm.configOverride?.experience },
        workflow: {
          completionVerification: { ...baseConfig.workflow.completionVerification, ...arm.configOverride?.workflow?.completionVerification },
          repoMap: { ...baseConfig.workflow.repoMap, ...arm.configOverride?.workflow?.repoMap } }
      }
    };
    writeFileSync(join(armDir, "arm-config.json"), `${JSON.stringify(armConfig, null, 2)}\n`, "utf8");
    armConfigs[arm.label] = armConfig;
    summaries[arm.label] = summarizeArm(arm.label, report);
    reports[arm.label] = report;
    if (!report.metrics.costUsd.available || !report.gate.passed) {
      throw new Error(`${arm.label}: invalid run or cost coverage below 100%; remaining arms stopped`);
    }
    cumulativeCostUsd += report.metrics.costUsd.total ?? 0;
    if (cumulativeCostUsd >= options.maxCostUsd) throw new Error("A/B budget exhausted; remaining arms stopped");
  }

  const governed = summaries.governed ?? null;
  const comprehensiveAblation = summaries["comprehensive-ablation"] ?? null;
  const comparison = {
    armConfigs,
    comprehensiveAblationDisables: [
      "compact",
      "toolResultPruning",
      "fileReadCache",
      "recall",
      "memory",
      "repoMap",
      "promotion",
      "experience",
      "completionVerification"
    ],
    deltas:
      governed === null || comprehensiveAblation === null
        ? null
        : {
            averageRounds: governed.averageRounds - comprehensiveAblation.averageRounds,
            averageToolCalls: governed.averageToolCalls - comprehensiveAblation.averageToolCalls,
            inputTokens: governed.inputTokens - comprehensiveAblation.inputTokens,
            passAtK: governed.passAtK - comprehensiveAblation.passAtK,
            successRate: governed.successRate - comprehensiveAblation.successRate,
            totalTokens: governed.totalTokens - comprehensiveAblation.totalTokens
          },
    generatedAt: new Date().toISOString(),
    paired: reports.governed === undefined ? null : Object.fromEntries(
      Object.entries(reports).filter(([label]) => label !== "governed").map(([label, report]) =>
        [label, pairedDeltas(reports.governed!, report)])
    ),
    governed,
    comprehensiveAblation,
    notDisabled: [
      "sandbox",
      "approval policy",
      "tool schema",
      "skills registry (empty workspace has none)",
      "delegation tool registration"
    ],
    provider: options.provider,
    repetitions: options.repetitions,
    suite: options.suite,
    taskIds: options.taskIds
  };
  const comparisonPath = join(outputRoot, "comparison.json");
  writeFileSync(comparisonPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(comparison, null, 2));
  console.error(`Wrote ${comparisonPath}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
