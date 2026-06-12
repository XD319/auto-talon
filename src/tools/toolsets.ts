import type { ToolDefinition, ToolSideEffectLevel } from "../types/index.js";
import { TOOLSET_NAMES, type ToolsetName } from "../types/index.js";

export const TOOLSET_TOOLS: Record<ToolsetName, readonly string[]> = {
  agent: ["delegate_task", "todo"],
  automation: ["cronjob"],
  file: ["read_file", "write_file", "patch", "search_files", "glob"],
  interaction: ["clarify"],
  mcp: ["mcp_tool_search", "mcp_resource", "mcp_prompt"],
  session: ["session_search"],
  shell: ["shell", "process"],
  skills: ["skills_list", "skill_view"],
  web: ["web_extract", "web_search"]
};

const READ_ONLY_SIDE_EFFECT_LEVELS = new Set<ToolSideEffectLevel>([
  "none",
  "read_only",
  "external_read_only"
]);

export function isReadOnlySideEffectLevel(sideEffectLevel: ToolSideEffectLevel): boolean {
  return READ_ONLY_SIDE_EFFECT_LEVELS.has(sideEffectLevel);
}

export function isPlanSafeTool(tool: ToolDefinition): boolean {
  return isReadOnlySideEffectLevel(tool.sideEffectLevel);
}

export function resolveToolsetForTool(toolName: string): ToolsetName {
  if (toolName.startsWith("mcp__")) {
    return "mcp";
  }

  for (const toolsetName of TOOLSET_NAMES) {
    if (toolsetName === "mcp") {
      continue;
    }
    if (TOOLSET_TOOLS[toolsetName].includes(toolName)) {
      return toolsetName;
    }
  }

  return "agent";
}

export function listPlanSafeToolNames(tools: ToolDefinition[]): string[] {
  return tools.filter(isPlanSafeTool).map((tool) => tool.name);
}
