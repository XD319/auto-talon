import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { AppError } from "../../core/app-error.js";
import { collectLegacySchemaIssues } from "../../storage/migrations.js";

export function listPendingJsonTranscriptFiles(workspaceRoot: string): string[] {
  const sessionsDir = join(workspaceRoot, ".auto-talon", "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }
  return readdirSync(sessionsDir).filter(
    (entry) => entry.endsWith(".json") && !entry.endsWith(".json.migrated")
  );
}

export function collectLegacyWorkspaceIssues(
  workspaceRoot: string,
  database: DatabaseSync
): string[] {
  const issues = collectLegacySchemaIssues(database);
  for (const fileName of listPendingJsonTranscriptFiles(workspaceRoot)) {
    issues.push(`Legacy JSON session transcript pending migration: .auto-talon/sessions/${fileName}`);
  }
  return issues;
}

export function assertLegacyWorkspaceMigrated(
  workspaceRoot: string,
  database: DatabaseSync
): void {
  const issues = collectLegacyWorkspaceIssues(workspaceRoot, database);
  if (issues.length === 0) {
    return;
  }
  throw new AppError({
    code: "invalid_state",
    message: [
      "Workspace requires a one-time legacy migration before use.",
      ...issues.map((issue) => `- ${issue}`),
      "Run: talon doctor --fix"
    ].join("\n")
  });
}
