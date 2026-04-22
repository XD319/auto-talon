import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ConfigMigrationSummary {
  migratedFiles: string[];
}

const CONFIG_FILES = [
  "provider.config.json",
  "runtime.config.json",
  "sandbox.config.json",
  "gateway.config.json",
  "feishu.config.json",
  "mcp.config.json",
  "mcp-server.config.json",
  "skill-overrides.json"
] as const;

const LATEST_VERSION = 1;

export function migrateConfigFiles(workspaceRoot: string): ConfigMigrationSummary {
  const migratedFiles: string[] = [];
  for (const fileName of CONFIG_FILES) {
    const fullPath = join(workspaceRoot, ".auto-talon", fileName);
    if (!existsSync(fullPath)) {
      continue;
    }
    const raw = readFileSync(fullPath, "utf8").trim();
    if (raw.length === 0) {
      continue;
    }
    const parsed = JSON.parse(raw) as { version?: number } & Record<string, unknown>;
    const currentVersion = typeof parsed.version === "number" ? parsed.version : 0;
    if (currentVersion >= LATEST_VERSION) {
      continue;
    }
    writeFileSync(
      fullPath,
      `${JSON.stringify(
        {
          ...parsed,
          version: LATEST_VERSION
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    migratedFiles.push(fileName);
  }
  return { migratedFiles };
}
