import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentProfileId } from "../../types/index.js";

export interface McpServerRuntimeConfig {
  exposeSkills: boolean;
  exposeTools: string[];
  externalIdentity: {
    runtimeUserId: string;
    agentProfileId: AgentProfileId;
  };
}

export function resolveMcpServerConfig(workspaceRoot: string): McpServerRuntimeConfig {
  const path = join(workspaceRoot, ".auto-talon", "mcp-server.config.json");
  if (!existsSync(path)) {
    return defaultConfig();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<McpServerRuntimeConfig>;
  return {
    exposeSkills: parsed.exposeSkills ?? true,
    exposeTools: normalizeExposeTools(parsed.exposeTools),
    externalIdentity: {
      agentProfileId:
        parsed.externalIdentity?.agentProfileId === "executor" ||
        parsed.externalIdentity?.agentProfileId === "planner" ||
        parsed.externalIdentity?.agentProfileId === "reviewer"
          ? parsed.externalIdentity.agentProfileId
          : "reviewer",
      runtimeUserId: parsed.externalIdentity?.runtimeUserId ?? "mcp_external"
    }
  };
}

function normalizeExposeTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (value === false) {
    return [];
  }
  return ["glob", "read_file", "skill_view", "web_extract"];
}

function defaultConfig(): McpServerRuntimeConfig {
  return {
    exposeSkills: true,
    exposeTools: ["glob", "read_file", "skill_view", "web_extract"],
    externalIdentity: {
      agentProfileId: "reviewer",
      runtimeUserId: "mcp_external"
    }
  };
}
