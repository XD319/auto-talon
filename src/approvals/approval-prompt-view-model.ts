import type { ApprovalRecord, SandboxExecutionPlan, ToolCallRecord, ToolRiskLevel } from "../types/index.js";

export interface ApprovalPromptContext {
  detailLines: string[];
  fingerprint: string | null;
  policyRuleId: string | null;
  riskLevel: ToolRiskLevel | "unknown";
  riskTags: string[];
  summaryLine: string;
  toolName: string;
}

export function buildApprovalPromptContext(
  approval: ApprovalRecord,
  toolCall: ToolCallRecord | null
): ApprovalPromptContext {
  const reasonLines = approval.reason.split("\n");
  const reasonMap = parseReasonLines(reasonLines);
  const riskLevel = toolCall?.riskLevel ?? "unknown";
  const detailLines = collectDetailLines(approval.toolName, toolCall, reasonMap);
  const riskTags = collectRiskTags(approval.toolName, toolCall, reasonMap);
  const summaryLine = buildSummaryLine(approval.toolName, toolCall, reasonMap);

  return {
    detailLines,
    fingerprint: approval.fingerprint,
    policyRuleId: extractPolicyRuleId(approval.reason),
    riskLevel,
    riskTags,
    summaryLine,
    toolName: approval.toolName
  };
}

export function formatApprovalPromptContext(context: ApprovalPromptContext): string {
  const lines = [`**${context.toolName}** [${context.riskLevel}]`, context.summaryLine];
  if (context.riskTags.length > 0) {
    lines.push(`Risk: ${context.riskTags.join(", ")}`);
  }
  for (const detail of context.detailLines) {
    lines.push(detail);
  }
  return lines.join("\n");
}

function parseReasonLines(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of lines) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (value.length > 0) {
      map.set(key, value);
    }
  }
  return map;
}

function collectDetailLines(
  toolName: string,
  toolCall: ToolCallRecord | null,
  reasonMap: Map<string, string>
): string[] {
  const lines: string[] = [];
  const path =
    readToolInputString(toolCall, "path") ??
    reasonMap.get("Resolved path") ??
    reasonMap.get("Path");
  const command = readToolInputString(toolCall, "command") ?? reasonMap.get("Command");
  const cwd = reasonMap.get("CWD");
  const url = readToolInputString(toolCall, "url") ?? reasonMap.get("URL");
  const method = reasonMap.get("Method");
  const mcpServer = reasonMap.get("MCP server");
  const mcpTool = reasonMap.get("MCP tool");
  const mcpTarget = reasonMap.get("Target");
  const operation = reasonMap.get("Operation");
  const pathScope = reasonMap.get("Path scope");
  const networkAccess = reasonMap.get("Network");

  if (path !== undefined) {
    lines.push(`path: ${path}`);
  }
  if (command !== undefined) {
    lines.push(`command: ${command}`);
  }
  if (cwd !== undefined) {
    lines.push(`cwd: ${cwd}`);
  }
  if (url !== undefined) {
    lines.push(`url: ${url}`);
  }
  if (method !== undefined) {
    lines.push(`method: ${method}`);
  }
  if (mcpServer !== undefined) {
    lines.push(`mcp server: ${mcpServer}`);
  }
  if (mcpTool !== undefined) {
    lines.push(`mcp tool: ${mcpTool}`);
  }
  if (mcpTarget !== undefined) {
    lines.push(`target: ${mcpTarget}`);
  }
  if (operation !== undefined) {
    lines.push(`operation: ${operation}`);
  }
  if (pathScope !== undefined) {
    lines.push(`path scope: ${pathScope}`);
  }
  if (networkAccess !== undefined && toolName === "shell") {
    lines.push(`network: ${networkAccess}`);
  }

  return lines;
}

function collectRiskTags(
  toolName: string,
  toolCall: ToolCallRecord | null,
  reasonMap: Map<string, string>
): string[] {
  const tags: string[] = [];
  if (toolName === "shell") {
    if (reasonMap.get("Network") === "unrestricted") {
      tags.push("network");
    }
    const command = readToolInputString(toolCall, "command") ?? reasonMap.get("Command") ?? "";
    if (/\brm\b|\bdel\b|\bremove-item\b|\bdrop\b|\btruncate\b/iu.test(command)) {
      tags.push("destructive");
    }
  }
  if (reasonMap.get("Path scope") === "outside_workspace") {
    tags.push("outside_workspace");
  }
  if (reasonMap.get("Extra write root") === "yes") {
    tags.push("extra_write_root");
  }
  return tags;
}

function buildSummaryLine(
  toolName: string,
  toolCall: ToolCallRecord | null,
  reasonMap: Map<string, string>
): string {
  const command = readToolInputString(toolCall, "command") ?? reasonMap.get("Command");
  const path = readToolInputString(toolCall, "path") ?? reasonMap.get("Resolved path");
  const url = readToolInputString(toolCall, "url") ?? reasonMap.get("URL");
  const mcpServer = reasonMap.get("MCP server");
  const mcpTool = reasonMap.get("MCP tool");

  if (command !== undefined) {
    return `${toolName}: ${command}`;
  }
  if (path !== undefined) {
    return `${toolName}: ${path}`;
  }
  if (url !== undefined) {
    return `${toolName}: ${url}`;
  }
  if (mcpServer !== undefined && mcpTool !== undefined) {
    return `${toolName}: ${mcpServer}/${mcpTool}`;
  }
  return toolName;
}

function extractPolicyRuleId(reason: string): string | null {
  const firstLine = reason.split("\n")[0] ?? reason;
  const match = /^([a-z0-9-]+):/iu.exec(firstLine);
  return match?.[1] ?? null;
}

function readToolInputString(toolCall: ToolCallRecord | null, key: string): string | undefined {
  const value = toolCall?.input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function sandboxPlanMatchesApprovalContext(
  sandboxPlan: SandboxExecutionPlan,
  toolName: string
): { command?: string; path?: string; url?: string } {
  switch (sandboxPlan.kind) {
    case "shell":
      return { command: sandboxPlan.command };
    case "file":
      return { path: sandboxPlan.resolvedPath };
    case "network":
      return { url: sandboxPlan.url };
    case "mcp":
      return { path: `${sandboxPlan.serverId}/${sandboxPlan.toolName}` };
    default:
      return { path: toolName };
  }
}
