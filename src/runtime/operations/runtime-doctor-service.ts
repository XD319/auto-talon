import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hasLegacyShortRemoteTimeout, type ResolvedProviderConfig } from "../../providers/index.js";
import type { ExperienceRecord, ProviderHealthCheck } from "../../types/index.js";

export interface RuntimeDoctorServiceDependencies {
  allowedFetchHosts: string[];
  databasePath: string;
  listExperiences: () => ExperienceRecord[];
  providerConfig: ResolvedProviderConfig;
  providerName: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  runtimeVersion: string;
  skillStats: () => {
    issues: unknown[];
    skills: unknown[];
  };
  testCurrentProvider: (signal?: AbortSignal) => Promise<ProviderHealthCheck>;
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
  workspaceRoot: string;
}

export class RuntimeDoctorService {
  public constructor(private readonly dependencies: RuntimeDoctorServiceDependencies) {}

  public async configDoctor(signal?: AbortSignal) {
    const providerHealth = await this.dependencies.testCurrentProvider(signal);
    const issues = collectDoctorIssues(this.dependencies.providerConfig, providerHealth);
    const experiences = this.dependencies.listExperiences();
    const skills = this.dependencies.skillStats();
    const configFiles = checkWorkspaceConfigFiles(this.dependencies.workspaceRoot);
    const workspaceSecretFindings = scanWorkspaceConfigSecrets(this.dependencies.workspaceRoot);
    const databaseReachable = canOpenDatabase(this.dependencies.databasePath);
    const schemaVersion = readSchemaVersion(this.dependencies.databasePath);
    const distFresh = checkDistFreshness(this.dependencies.workspaceRoot);
    const corepackAvailable = isCommandAvailable("corepack");
    const pnpmVersion = resolveCommandVersion("pnpm");

    return {
      apiKeyConfigured: providerHealth.apiKeyConfigured,
      allowedFetchHosts: this.dependencies.allowedFetchHosts,
      configPath: this.dependencies.providerConfig.configPath,
      configSource: this.dependencies.providerConfig.configSource,
      databasePath: this.dependencies.databasePath,
      endpointReachable: providerHealth.endpointReachable,
      experienceStats: {
        accepted: experiences.filter((experience) => experience.status === "accepted").length,
        candidate: experiences.filter((experience) => experience.status === "candidate").length,
        promoted: experiences.filter((experience) => experience.status === "promoted").length,
        rejected: experiences.filter((experience) => experience.status === "rejected").length,
        stale: experiences.filter((experience) => experience.status === "stale").length,
        total: experiences.length
      },
      issues: [
        ...issues,
        ...workspaceSecretFindings.map(
          (finding) =>
            `Workspace config ${finding.file} contains provider secret fields (${finding.fields.join(", ")}). Move secrets to env or user config.`
        )
      ],
      maxRetries: this.dependencies.providerConfig.maxRetries,
      modelAvailable: providerHealth.modelAvailable,
      modelConfigured: providerHealth.modelConfigured,
      modelName: providerHealth.modelName,
      nodeVersion: process.version,
      pnpmVersion,
      corepackAvailable,
      providerHealthMessage: providerHealth.message,
      providerName: this.dependencies.providerName,
      runtimeConfigPath: this.dependencies.runtimeConfigPath,
      runtimeConfigSource: this.dependencies.runtimeConfigSource,
      runtimeVersion: this.dependencies.runtimeVersion,
      configFiles,
      workspaceSecretFindings,
      databaseReachable,
      distFresh,
      schemaVersion,
      shell: process.env.ComSpec,
      skillStats: {
        enabled: skills.skills.length,
        issues: skills.issues.length,
        total: skills.skills.length + skills.issues.length
      },
      tokenBudget: this.dependencies.tokenBudget,
      timeoutMs: this.dependencies.providerConfig.timeoutMs,
      streamIdleTimeoutMs: this.dependencies.providerConfig.streamIdleTimeoutMs,
      workspaceRoot: this.dependencies.workspaceRoot
    };
  }
}

function scanWorkspaceConfigSecrets(
  workspaceRoot: string
): Array<{ file: string; fields: string[] }> {
  const providerConfigPath = join(workspaceRoot, ".auto-talon", "provider.config.json");
  if (!existsSync(providerConfigPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(providerConfigPath, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const fields = collectSecretFields(parsed, []);
    return fields.length === 0
      ? []
      : [
          {
            fields,
            file: "provider.config.json"
          }
        ];
  } catch {
    return [];
  }
}

function collectSecretFields(value: unknown, path: string[]): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const fields: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isSecretField(key, child)) {
      fields.push(nextPath.join("."));
      continue;
    }
    fields.push(...collectSecretFields(child, nextPath));
  }
  return fields;
}

function isSecretField(key: string, value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  return /^(apiKey|api_key|token|secret|password)$/iu.test(key);
}

function collectDoctorIssues(
  providerConfig: ResolvedProviderConfig,
  providerHealth: ProviderHealthCheck
): string[] {
  const issues: string[] = [];

  if (!providerHealth.apiKeyConfigured && providerConfig.name !== "mock") {
    issues.push("API key is missing.");
  }

  if (!providerHealth.modelConfigured) {
    issues.push("Model is not configured.");
  }

  if (providerHealth.endpointReachable === false) {
    issues.push("Provider endpoint is not reachable.");
  }

  if (providerHealth.modelAvailable === false) {
    issues.push(`Model ${providerHealth.modelName ?? "-"} is not available on the provider endpoint.`);
  }

  if (hasLegacyShortRemoteTimeout(providerConfig)) {
    issues.push(
      `Provider request timeout is explicitly ${providerConfig.timeoutMs}ms; remote tool turns may need talon provider setup ${providerConfig.name} --timeout-ms 120000.`
    );
  }

  if (!isCommandAvailable("corepack")) {
    issues.push("corepack is not available.");
  }

  return issues;
}

function checkWorkspaceConfigFiles(
  workspaceRoot: string
): Array<{ exists: boolean; file: string; parseable: boolean }> {
  const files = [
    "provider.config.json",
    "runtime.config.json",
    "sandbox.config.json",
    "gateway.config.json",
    "feishu.config.json",
    "mcp.config.json",
    "mcp-server.config.json"
  ];

  return files.map((file) => {
    const path = join(workspaceRoot, ".auto-talon", file);
    if (!existsSync(path)) {
      return { exists: false, file, parseable: false };
    }
    try {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) {
        JSON.parse(content);
      }
      return { exists: true, file, parseable: true };
    } catch {
      return { exists: true, file, parseable: false };
    }
  });
}

function canOpenDatabase(databasePath: string): boolean {
  if (databasePath === ":memory:") {
    return true;
  }
  try {
    const db = new DatabaseSync(databasePath);
    db.close();
    return true;
  } catch {
    return false;
  }
}

function readSchemaVersion(databasePath: string): number | null {
  if (databasePath === ":memory:" || !existsSync(databasePath)) {
    return null;
  }
  try {
    const db = new DatabaseSync(databasePath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return null;
  }
}

function checkDistFreshness(workspaceRoot: string): boolean | null {
  const cliSource = join(workspaceRoot, "src", "cli", "index.ts");
  const cliDist = join(workspaceRoot, "dist", "cli", "index.js");
  if (!existsSync(cliSource) || !existsSync(cliDist)) {
    return null;
  }
  return statSync(cliDist).mtimeMs >= statSync(cliSource).mtimeMs;
}

function isCommandAvailable(command: string): boolean {
  return (
    spawnSync(command, ["--version"], {
      encoding: "utf8",
      shell: process.platform === "win32"
    }).status === 0
  );
}

function resolveCommandVersion(command: string): string | null {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: process.platform === "win32"
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim().split("\n")[0] ?? null;
}
