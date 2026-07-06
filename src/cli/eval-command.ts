import { writeFileSync } from "node:fs";

import type { Command } from "commander";

import {
  replayTaskById,
  runBetaReadinessCheck,
  runCodingEvalReport,
  runEvalReport,
  runReleaseChecklist
} from "../diagnostics/index.js";
import type { SupportedProviderName } from "../providers/index.js";
import { formatSmokeSuiteReport, runSmokeSuite } from "../testing/index.js";
import {
  formatBetaReadinessReport,
  formatCodingEvalReport,
  formatEvalReport,
  formatReleaseChecklistReport,
  formatReplayReport
} from "./formatters.js";
import { parsePositiveIntegerOption, parseRatioOption } from "./cli-helpers.js";

interface SmokeCommandOptions {
  autoApprove: boolean;
  fixture?: string;
  provider: SupportedProviderName | "scripted-smoke";
  tasks?: string;
}

export function registerEvalCommands(program: Command): void {
  const smokeCommand = program.command("smoke").description("Run fixed runtime smoke tasks");

  program
    .command("replay")
    .argument("<task_id>", "Task identifier")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--from-iteration <number>", "Replay starting from this iteration", parsePositiveIntegerOption("--from-iteration"), 1)
    .option("--provider <mode>", "Replay provider mode: current | mock", "current")
    .option("--dry-run", "Show replay parameters without executing")
    .action(
      async (
        taskId: string,
        commandOptions: {
          cwd: string;
          dryRun?: boolean;
          fromIteration: number;
          provider: "current" | "mock";
        }
      ) => {
        if (commandOptions.dryRun === true) {
          console.log(
            `Replay dry-run: task=${taskId} cwd=${commandOptions.cwd} fromIteration=${commandOptions.fromIteration} provider=${commandOptions.provider}`
          );
          return;
        }
        const report = await replayTaskById(taskId, {
          cwd: commandOptions.cwd,
          fromIteration: commandOptions.fromIteration,
          providerMode: commandOptions.provider
        });
        console.log(formatReplayReport(report));
        if (report.replayTask.status === "failed" || report.replayTask.status === "cancelled") {
          process.exitCode = 1;
        }
      }
    );

  const evalCommand = program.command("eval").description("Run minimal eval and beta readiness checks");

  evalCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--json", "Print JSON instead of text")
    .option("--explain", "Append plain-language explanation")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        explain?: boolean;
        json?: boolean;
        output?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        const report = await runEvalReport({
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        let output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatEvalReport(report);
        if (commandOptions.explain === true && commandOptions.json !== true) {
          output = `${output}\nExplanation: The suite validates repeatable core workflows and flags provider/policy regressions.`;
        }
        if (commandOptions.output !== undefined) {
          writeFileSync(commandOptions.output, `${output}\n`, "utf8");
        } else {
          console.log(output);
        }
        if (report.successRate < 1) {
          process.exitCode = 1;
        }
      }
    );

  evalCommand
    .command("smoke")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(
      async (commandOptions: SmokeCommandOptions) => {
        console.warn("Warning: `talon eval smoke` is a compatibility alias; use `talon smoke run`.");
        await runSmokeCommand(commandOptions);
      }
    );

  evalCommand
    .command("coding")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated coding task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--min-success-rate <number>", "Minimum acceptable coding task success rate", parseRatioOption("--min-success-rate"), 0.8)
    .option("--json", "Print JSON instead of text")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        json?: boolean;
        minSuccessRate: number;
        output?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        const report = await runCodingEvalReport({
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          minimumSuccessRate: commandOptions.minSuccessRate,
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        const output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatCodingEvalReport(report);
        if (commandOptions.output !== undefined) {
          writeFileSync(commandOptions.output, `${output}\n`, "utf8");
        } else {
          console.log(output);
        }
        if (!report.betaGate.passed) {
          process.exitCode = 1;
        }
      }
    );

  const releaseCommand = program.command("release").description("Release readiness checks");
  releaseCommand
    .command("check")
    .option("--provider <provider>", "Provider to use for eval checks", "scripted-smoke")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (commandOptions: { cwd: string; provider: SupportedProviderName | "scripted-smoke" }) => {
      const report = await runReleaseChecklist({
        cwd: commandOptions.cwd,
        provider: commandOptions.provider
      });
      console.log(formatReleaseChecklistReport(report));
      if (!report.allPassed) {
        process.exitCode = 1;
      }
    });

  evalCommand
    .command("beta")
    .option("--provider <provider>", "Provider to use for sample eval: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--min-success-rate <number>", "Minimum acceptable task success rate", parseRatioOption("--min-success-rate"), 0.8)
    .action(
      async (commandOptions: {
        minSuccessRate: number;
        provider: SupportedProviderName | "scripted-smoke";
      }) => {
        const report = await runBetaReadinessCheck({
          minimumSuccessRate: commandOptions.minSuccessRate,
          providerName: commandOptions.provider
        });
        console.log(formatBetaReadinessReport(report));
        if (!report.allPassed) {
          process.exitCode = 1;
        }
      }
    );

  smokeCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(async (commandOptions: SmokeCommandOptions) => {
      await runSmokeCommand(commandOptions);
    });
}

async function runSmokeCommand(commandOptions: SmokeCommandOptions): Promise<void> {
  const report = await runSmokeSuite({
    autoApprove: commandOptions.autoApprove,
    ...(commandOptions.fixture !== undefined
      ? { fixturePath: commandOptions.fixture }
      : {}),
    providerName: commandOptions.provider,
    taskIds:
      commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
  });
  console.log(formatSmokeSuiteReport(report));
  if (report.failedCount > 0) {
    process.exitCode = 1;
  }
}
