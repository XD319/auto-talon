import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";

import type { EvalRunReport } from "./types.js";

export async function writeEvalArtifacts(report: EvalRunReport, outputDirectory: string): Promise<{
  jsonPath: string;
  junitPath: string;
}> {
  const directory = resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = join(directory, "eval-report.json");
  const junitPath = join(directory, "eval-report.junit.xml");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(junitPath, toJunit(report), "utf8");
  await fs.mkdir(join(directory, "tasks"), { recursive: true });
  for (const task of report.tasks) {
    await fs.writeFile(join(directory, "tasks", `${safeName(task.task.id)}.json`), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }
  return { jsonPath, junitPath };
}

function toJunit(report: EvalRunReport): string {
  const trials = report.tasks.flatMap((task) => task.trials.map((trial) => ({ task, trial })));
  const failures = trials.filter(({ trial }) => !trial.success).length;
  const cases = trials.map(({ task, trial }) => {
    const failure = trial.success ? "" : `<failure type="${escapeXml(trial.failureClassification ?? "unknown")}" message="eval failed">${escapeXml(trial.scorerResults.filter((score) => score.required && !score.passed).map((score) => `${score.id}: ${score.evidence}`).join("\n"))}</failure>`;
    return `<testcase classname="${escapeXml(task.task.category)}" name="${escapeXml(`${task.task.id}#${trial.trial}`)}" time="${(trial.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(report.suite.id)}" tests="${trials.length}" failures="${failures}">${cases}</testsuite>\n`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
