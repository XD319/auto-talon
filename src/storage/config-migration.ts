import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ConfigMigrationSummary {
  migratedFiles: string[];
}

type ConfigFileName =
  | "provider.config.json"
  | "runtime.config.json"
  | "sandbox.config.json"
  | "gateway.config.json"
  | "feishu.config.json"
  | "mcp.config.json"
  | "mcp-server.config.json"
  | "skill-overrides.json";

const CONFIG_FILES: ConfigFileName[] = [
  "provider.config.json",
  "runtime.config.json",
  "sandbox.config.json",
  "gateway.config.json",
  "feishu.config.json",
  "mcp.config.json",
  "mcp-server.config.json",
  "skill-overrides.json"
] as const;

export const LATEST_CONFIG_VERSION = 2;

export class ConfigVersionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigVersionError";
  }
}

interface ConfigMigrationStep {
  fileName: ConfigFileName;
  fromVersion: number;
  migrate: (config: Record<string, unknown>) => Record<string, unknown>;
  toVersion: number;
}

const MIGRATION_STEPS: ConfigMigrationStep[] = [
  {
    fileName: "provider.config.json",
    fromVersion: 1,
    toVersion: 2,
    migrate: (config) => ({
      ...config,
      contractVersion: 1
    })
  }
];

export function migrateConfigFiles(workspaceRoot: string): ConfigMigrationSummary {
  const migratedFiles: string[] = [];
  for (const fileName of CONFIG_FILES) {
    const fullPath = resolveConfigPath(workspaceRoot, fileName);
    if (!existsSync(fullPath)) {
      continue;
    }
    const parsed = readConfigFile(fullPath, fileName);
    if (parsed === null) {
      continue;
    }
    let currentVersion = typeof parsed.version === "number" ? parsed.version : 0;
    let nextValue: Record<string, unknown> = parsed;
    let changed = false;

    while (currentVersion < LATEST_CONFIG_VERSION) {
      const step = MIGRATION_STEPS.find(
        (candidate) => candidate.fileName === fileName && candidate.fromVersion === currentVersion
      );
      if (step === undefined) {
        nextValue = {
          ...nextValue,
          version: LATEST_CONFIG_VERSION
        };
        changed = true;
        break;
      }
      try {
        nextValue = step.migrate(nextValue);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to migrate ${fileName} from version ${step.fromVersion} to ${step.toVersion}: ` +
            `${message}. Please review the config manually and retry.`
        );
      }
      currentVersion = step.toVersion;
      nextValue = {
        ...nextValue,
        version: currentVersion
      };
      changed = true;
    }

    if (changed) {
      writeConfigFile(fullPath, nextValue);
      migratedFiles.push(fileName);
    }
  }
  return { migratedFiles };
}

export function validateConfigVersions(workspaceRoot: string): void {
  for (const fileName of CONFIG_FILES) {
    const fullPath = resolveConfigPath(workspaceRoot, fileName);
    if (!existsSync(fullPath)) {
      continue;
    }
    const parsed = readConfigFile(fullPath, fileName);
    if (parsed === null) {
      continue;
    }
    if (typeof parsed.version !== "number") {
      console.warn(`[config-migration] ${fileName} has no version field; treating as legacy config.`);
      continue;
    }
    if (parsed.version > LATEST_CONFIG_VERSION) {
      throw new ConfigVersionError(
        `Config file ${fileName} has version ${parsed.version} which is newer than supported version ${LATEST_CONFIG_VERSION}. Please upgrade auto-talon.`
      );
    }
  }
}

function resolveConfigPath(workspaceRoot: string, fileName: ConfigFileName): string {
  return join(workspaceRoot, ".auto-talon", fileName);
}

function readConfigFile(
  fullPath: string,
  fileName: ConfigFileName
): ({ version?: number } & Record<string, unknown>) | null {
  const raw = readFileSync(fullPath, "utf8").trim();
  if (raw.length === 0) {
    return null;
  }
  try {
    return JSON.parse(raw) as { version?: number } & Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${fileName}: ${message}. Please fix the JSON syntax.`);
  }
}

function writeConfigFile(fullPath: string, value: Record<string, unknown>): void {
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
