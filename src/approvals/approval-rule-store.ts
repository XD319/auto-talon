import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildShellPrefixPattern, matchesShellPrefixPattern } from "./approval-fingerprint.js";
import type {
  ApprovalRecord,
  ApprovalRuleKind,
  ApprovalRulesConfig,
  PersistedApprovalRule,
  SandboxExecutionPlan
} from "../types/index.js";

const DEFAULT_CONFIG: ApprovalRulesConfig = {
  version: 1,
  rules: []
};

export class ApprovalRuleStore {
  private readonly path: string;

  public constructor(workspaceRoot: string) {
    this.path = join(workspaceRoot, ".auto-talon", "approval-rules.json");
  }

  public read(): ApprovalRulesConfig {
    if (!existsSync(this.path)) {
      return DEFAULT_CONFIG;
    }
    const raw = readFileSync(this.path, "utf8").trim();
    if (raw.length === 0) {
      return DEFAULT_CONFIG;
    }
    const parsed = JSON.parse(raw) as Partial<ApprovalRulesConfig>;
    return {
      version: 1,
      rules: Array.isArray(parsed.rules) ? parsed.rules : []
    };
  }

  public list(): PersistedApprovalRule[] {
    return this.read().rules;
  }

  public hasFingerprint(fingerprint: string): boolean {
    return this.list().some((rule) => resolveRuleKind(rule) === "fingerprint" && rule.fingerprint === fingerprint);
  }

  public matches(sandboxPlan: SandboxExecutionPlan, toolName: string): boolean {
    const matchingRules = this.list().filter((rule) => this.ruleMatches(rule, sandboxPlan, toolName));
    return matchingRules.length === 1;
  }

  public add(rule: PersistedApprovalRule): void {
    const config = this.read();
    const kind = resolveRuleKind(rule);
    if (
      config.rules.some((item) => {
        if (resolveRuleKind(item) !== kind) {
          return false;
        }
        if (kind === "fingerprint") {
          return item.fingerprint === rule.fingerprint;
        }
        if (kind === "shell_prefix") {
          return (
            item.toolName === rule.toolName &&
            JSON.stringify(item.pattern ?? []) === JSON.stringify(rule.pattern ?? [])
          );
        }
        return item.toolName === rule.toolName && item.pathPrefix === rule.pathPrefix;
      })
    ) {
      return;
    }
    config.rules.push(rule);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  public addAlwaysRulesFromApproval(approval: ApprovalRecord, reviewerId: string): void {
    if (approval.fingerprint === null) {
      return;
    }

    const description = approval.reason.split("\n")[0] ?? approval.toolName;
    const createdAt = new Date().toISOString();
    this.add({
      createdAt,
      createdBy: reviewerId,
      description,
      fingerprint: approval.fingerprint,
      kind: "fingerprint",
      toolName: approval.toolName
    });

    const reasonMap = parseApprovalReasonMap(approval.reason);
    if (approval.toolName === "shell") {
      const command = reasonMap.get("Command");
      if (command !== undefined) {
        const pattern = buildShellPrefixPattern(command);
        if (pattern.length > 0) {
          this.add({
            createdAt,
            createdBy: reviewerId,
            description: `${approval.toolName} ${pattern.join(" ")}`,
            kind: "shell_prefix",
            pattern,
            toolName: approval.toolName
          });
        }
      }
    }

    const resolvedPath = reasonMap.get("Resolved path");
    if (
      resolvedPath !== undefined &&
      (approval.toolName === "write_file" || approval.toolName === "patch")
    ) {
      this.add({
        createdAt,
        createdBy: reviewerId,
        description: `${approval.toolName} ${resolvedPath}`,
        kind: "tool_prefix",
        pathPrefix: resolvedPath,
        toolName: approval.toolName
      });
    }
  }

  private ruleMatches(
    rule: PersistedApprovalRule,
    sandboxPlan: SandboxExecutionPlan,
    toolName: string
  ): boolean {
    const kind = resolveRuleKind(rule);
    switch (kind) {
      case "fingerprint":
        return false;
      case "shell_prefix":
        if (sandboxPlan.kind !== "shell" || rule.toolName !== toolName) {
          return false;
        }
        return matchesShellPrefixPattern(sandboxPlan.command, rule.pattern ?? []);
      case "tool_prefix":
        if (rule.toolName !== toolName) {
          return false;
        }
        if (rule.pathPrefix === undefined || rule.pathPrefix.length === 0) {
          return sandboxPlan.kind === "file";
        }
        if (sandboxPlan.kind !== "file") {
          return false;
        }
        return sandboxPlan.resolvedPath.toLowerCase().startsWith(rule.pathPrefix.toLowerCase());
      default:
        return false;
    }
  }
}

function resolveRuleKind(rule: PersistedApprovalRule): ApprovalRuleKind {
  if (rule.kind !== undefined) {
    return rule.kind;
  }
  return rule.fingerprint !== undefined ? "fingerprint" : "shell_prefix";
}

function parseApprovalReasonMap(reason: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of reason.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    map.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
  }
  return map;
}
