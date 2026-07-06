import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { DEFAULT_LOCAL_POLICY_CONFIG } from "../policy/default-policy-config.js";

type JsonObject = Record<string, unknown>;

const CONFIG_VERSION = 1;

const DEFAULT_PROVIDER_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  providers: {}
};

const DEFAULT_RUNTIME_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  approvalTtlMs: 300000,
  defaultMaxIterations: 12,
  defaultTimeoutMs: 120000,
  allowedFetchHosts: ["*"],
  webSearch: {
    backend: "disabled",
    apiKeyEnv: "FIRECRAWL_API_KEY",
    apiUrl: "https://api.firecrawl.dev/v1/search",
    maxResults: 5
  },
  web: {
    backend: "auto",
    searchBackend: "auto",
    extractBackend: "http",
    maxResults: 5,
    longPageThresholdBytes: 64000,
    summaryTargetBytes: 5000,
    providers: {
      firecrawl: {
        apiKeyEnv: "FIRECRAWL_API_KEY",
        apiUrl: "https://api.firecrawl.dev/v1/search"
      },
      tavily: {
        apiKeyEnv: "TAVILY_API_KEY",
        apiUrl: "https://api.tavily.com/search"
      },
      exa: {
        apiKeyEnv: "EXA_API_KEY",
        apiUrl: "https://api.exa.ai/search"
      },
      searxng: {},
      brave: {
        apiKeyEnv: "BRAVE_SEARCH_API_KEY",
        apiUrl: "https://api.search.brave.com/res/v1/web/search"
      },
      ddgs: {}
    }
  },
  context: {
    engine: "hermes_compressor"
  },
  compact: {
    thresholdRatio: 0.5,
    targetRatio: 0.2,
    protectFirstN: 3,
    protectLastN: 20,
    hygieneThresholdRatio: 0.85,
    summarizer: "provider_subagent"
  },
  tokenBudget: {
    outputLimit: 8000,
    reservedOutput: 1000,
    unknownContextWindowFallback: 32000
  },
  workflow: {
    testCommands: ["npm test", "npm run build"],
    failureGuidedRetry: {
      enabled: true,
      maxRepairAttempts: 2
    },
    maxShellTimeoutMs: 30000,
    shellBackend: "default",
    longRunningCommands: [],
    repoMap: {
      enabled: true
    }
  }
};

const DEFAULT_POLICY_CONFIG: JsonObject = {
  version: CONFIG_VERSION,
  ...DEFAULT_LOCAL_POLICY_CONFIG
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

const DEFAULT_TOOL_OVERRIDES: JsonObject = {
  version: CONFIG_VERSION,
  disabledToolNames: []
};

const DEFAULT_APPROVAL_RULES: JsonObject = {
  version: CONFIG_VERSION,
  rules: []
};

export interface InitWorkspaceResult {
  createdFiles: string[];
  workspaceConfigDir: string;
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
    ...writeConfigIfMissing(workspaceRoot, "policy.config.json", DEFAULT_POLICY_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "sandbox.config.json", DEFAULT_SANDBOX_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "gateway.config.json", DEFAULT_GATEWAY_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "feishu.config.json", DEFAULT_FEISHU_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "mcp.config.json", DEFAULT_MCP_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "mcp-server.config.json", DEFAULT_MCP_SERVER_CONFIG),
    ...writeConfigIfMissing(workspaceRoot, "skill-overrides.json", DEFAULT_SKILL_OVERRIDES),
    ...writeConfigIfMissing(workspaceRoot, "tool-overrides.json", DEFAULT_TOOL_OVERRIDES),
    ...writeConfigIfMissing(workspaceRoot, "approval-rules.json", DEFAULT_APPROVAL_RULES),
    ...writeHttpTokenIfMissing(workspaceRoot)
  );

  return {
    createdFiles,
    workspaceConfigDir
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

function writeHttpTokenIfMissing(workspaceRoot: string): string[] {
  const tokenPath = join(workspaceRoot, ".auto-talon", "http.token");
  if (existsSync(tokenPath)) {
    return [];
  }
  writeFileSync(tokenPath, `${randomBytes(32).toString("hex")}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return [tokenPath];
}
