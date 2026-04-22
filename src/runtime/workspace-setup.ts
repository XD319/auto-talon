import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

interface VersionedConfig {
  version?: number;
  [key: string]: unknown;
}

const CONFIG_VERSION = 1;

const DEFAULT_PROVIDER_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  currentProvider: "mock",
  providers: {
    mock: {
      model: "mock-default"
    }
  }
};

const DEFAULT_RUNTIME_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  defaultMaxIterations: 12,
  defaultTimeoutMs: 120000,
  allowedFetchHosts: ["*"],
  tokenBudget: {
    inputLimit: 64000,
    outputLimit: 8000,
    reservedOutput: 1000
  },
  workflow: {
    testCommands: ["npm test", "npm run build"],
    failureGuidedRetry: {
      enabled: true,
      maxRepairAttempts: 2
    },
    repoMap: {
      enabled: true
    }
  }
};

const DEFAULT_SANDBOX_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  defaultProfile: "default",
  profiles: {
    default: {
      mode: "local",
      network: "controlled",
      readRoots: [],
      writeRoots: []
    }
  }
};

const DEFAULT_GATEWAY_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  allowlist: [],
  denylist: [],
  rateLimit: {
    burst: 20,
    refillPerSecond: 5
  }
};

const DEFAULT_FEISHU_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  appId: "",
  appSecret: "",
  domain: "feishu"
};

const DEFAULT_MCP_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  servers: []
};

const DEFAULT_MCP_SERVER_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  exposeSkills: true,
  exposeTools: true,
  externalIdentity: "auto-talon-mcp"
};

const DEFAULT_SKILL_OVERRIDES: JsonObject = {
  version: CONFIG_VERSION,
  disabledSkillIds: []
};

export interface InitWorkspaceResult {
  createdFiles: string[];
  workspaceConfigDir: string;
}

export interface ConfigMigrationResult {
  migrated: string[];
}

export function initializeWorkspaceFiles(workspaceRoot: string): InitWorkspaceResult {
  const workspaceConfigDir = join(workspaceRoot, ".auto-talon");
  mkdirSync(workspaceConfigDir, { recursive: true });
  mkdirSync(join(workspaceConfigDir, "skills"), { recursive: true });
  mkdirSync(join(workspaceConfigDir, "sessions"), { recursive: true });
  mkdirSync(join(workspaceConfigDir, "rollbacks"), { recursive: true });
  mkdirSync(join(workspaceConfigDir, "skill-drafts"), { recursive: true });

  const createdFiles: string[] = [];
  createdFiles.push(
    ...writeConfigIfMissing(workspaceRoot, "provider.config.json", DEFAULT_PROVIDER_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "runtime.config.json", DEFAULT_RUNTIME_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "sandbox.config.json", DEFAULT_SANDBOX_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "gateway.config.json", DEFAULT_GATEWAY_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "feishu.config.json", DEFAULT_FEISHU_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "mcp.config.json", DEFAULT_MCP_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "mcp-server.config.json", DEFAULT_MCP_SERVER_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "skill-overrides.json", DEFAULT_SKILL_OVERRIDES)
  );

  return {
    createdFiles,
    workspaceConfigDir
  };
}

export function migrateWorkspaceConfigFiles(workspaceRoot: string): ConfigMigrationResult {
  const files = [
    "provider.config.json",
    "runtime.config.json",
    "sandbox.config.json",
    "gateway.config.json",
    "feishu.config.json",
    "mcp.config.json",
    "mcp-server.config.json",
    "skill-overrides.json"
  ];

  const migrated: string[] = [];
  for (const fileName of files) {
    const configPath = join(workspaceRoot, ".auto-talon", fileName);
    if (!existsSync(configPath)) {
      continue;
    }
    const raw = readFileSync(configPath, "utf8").trim();
    if (raw.length === 0) {
      continue;
    }
    const parsed = JSON.parse(raw) as VersionedConfig;
    const next = migrateToLatest(parsed);
    if (next.changed) {
      writeFileSync(configPath, `${JSON.stringify(next.value, null, 2)}\n`, "utf8");
      migrated.push(fileName);
    }
  }

  return { migrated };
}

function migrateToLatest(config: VersionedConfig): { changed: boolean; value: VersionedConfig } {
  const currentVersion = typeof config.version === "number" ? config.version : 0;
  if (currentVersion >= CONFIG_VERSION) {
    return { changed: false, value: config };
  }
  return {
    changed: true,
    value: {
      ...config,
      version: CONFIG_VERSION
    }
  };
}

function writeConfigIfMissing(workspaceRoot: string, fileName: string, value: JsonObject): string[] {
  const configPath = join(workspaceRoot, ".auto-talon", fileName);
  if (existsSync(configPath)) {
    return [];
  }
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return [configPath];
}
