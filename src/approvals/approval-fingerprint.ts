import { createHash } from "node:crypto";

import type { ApprovalFingerprintRecord, SandboxExecutionPlan } from "../types/index.js";

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").toLowerCase();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}

export function buildApprovalFingerprint(
  toolName: string,
  sandboxPlan: SandboxExecutionPlan
): ApprovalFingerprintRecord {
  let raw = `${toolName}|unknown`;
  let description = toolName;

  switch (sandboxPlan.kind) {
    case "file":
      raw = [
        toolName,
        "file",
        sandboxPlan.operation,
        normalizePath(sandboxPlan.resolvedPath)
      ].join("|");
      description = `${toolName} ${sandboxPlan.operation} ${sandboxPlan.resolvedPath}`;
      break;
    case "shell":
      raw = [
        toolName,
        "shell",
        normalizeWhitespace(sandboxPlan.command),
        normalizePath(sandboxPlan.cwd),
        sandboxPlan.executable.toLowerCase(),
        sandboxPlan.networkAccess
      ].join("|");
      description = `${toolName} ${sandboxPlan.command}`;
      break;
    case "network":
      raw = [
        toolName,
        "network",
        sandboxPlan.method,
        normalizeUrl(sandboxPlan.url)
      ].join("|");
      description = `${toolName} ${sandboxPlan.method} ${sandboxPlan.url}`;
      break;
    case "mcp":
      raw = [
        toolName,
        "mcp",
        sandboxPlan.serverId,
        sandboxPlan.toolName,
        normalizeWhitespace(sandboxPlan.target)
      ].join("|");
      description = `${toolName} ${sandboxPlan.serverId}/${sandboxPlan.toolName} ${sandboxPlan.target}`;
      break;
  }

  return {
    description,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    toolName
  };
}
