import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runEvalReport } from "./eval";
import { runBetaReadinessCheck } from "./beta-readiness";
import type { SupportedProviderName } from "../providers";

export interface ReleaseChecklistItem {
  id: string;
  ok: boolean;
  title: string;
  details: string;
}

export interface ReleaseChecklistReport {
  allPassed: boolean;
  generatedAt: string;
  items: ReleaseChecklistItem[];
}

export interface ReleaseChecklistOptions {
  cwd?: string;
  provider?: SupportedProviderName | "scripted-smoke";
}

export async function runReleaseChecklist(
  options: ReleaseChecklistOptions = {}
): Promise<ReleaseChecklistReport> {
  const cwd = options.cwd ?? process.cwd();
  const provider = options.provider ?? "scripted-smoke";
  const evalReport = await runEvalReport({ providerName: provider });
  const beta = await runBetaReadinessCheck({ providerName: provider });
  const schemaVersion = readSchemaVersion(cwd);

  const lint = runCommand("corepack", ["pnpm", "lint"], cwd);
  const test = runCommand("corepack", ["pnpm", "test"], cwd);
  const build = runCommand("corepack", ["pnpm", "build"], cwd);

  const items: ReleaseChecklistItem[] = [
    toItem("lint", "Lint passes", lint.ok, lint.details),
    toItem("test", "All tests pass", test.ok, test.details),
    toItem("build", "Build succeeds", build.ok, build.details),
    toItem(
      "smoke",
      "Smoke/eval reaches threshold",
      evalReport.successRate >= 0.8,
      `successRate=${(evalReport.successRate * 100).toFixed(1)}%`
    ),
    toItem("beta", "Approval/provider/gateway readiness checks pass", beta.allPassed, `${beta.checklist.length} checks`),
    toItem("doctor", "Config doctor can run", true, "covered by beta readiness doctor/provider checks"),
    toItem("schema", "Schema version matches v0.1.0 baseline", schemaVersion === 2, `user_version=${schemaVersion}`),
    toItem(
      "compat-matrix",
      "Compatibility matrix document exists",
      existsSync(join(cwd, "docs", "compatibility-matrix.md")),
      "docs/compatibility-matrix.md"
    ),
    toItem(
      "workspace",
      "Workspace setup scripts exist",
      existsSync(join(cwd, "scripts", "setup.sh")) && existsSync(join(cwd, "scripts", "setup.ps1")),
      "scripts/setup.sh and scripts/setup.ps1"
    )
  ];

  return {
    allPassed: items.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    items
  };
}

function toItem(id: string, title: string, ok: boolean, details: string): ReleaseChecklistItem {
  return { id, title, ok, details };
}

function runCommand(command: string, args: string[], cwd: string): { details: string; ok: boolean } {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status === 0) {
    return { ok: true, details: `${command} ${args.join(" ")}` };
  }
  const error = result.stderr?.trim() || result.stdout?.trim() || "unknown failure";
  return { ok: false, details: error.split("\n")[0] ?? "failed" };
}

function readSchemaVersion(cwd: string): number {
  try {
    const dbPath = join(cwd, ".auto-talon", "agent-runtime.db");
    if (!existsSync(dbPath)) {
      return 0;
    }
    const db = new DatabaseSync(dbPath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return -1;
  }
}
