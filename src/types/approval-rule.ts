export const APPROVAL_RULE_KINDS = ["fingerprint", "shell_prefix", "tool_prefix"] as const;

export type ApprovalRuleKind = (typeof APPROVAL_RULE_KINDS)[number];

export const APPROVAL_ALLOW_SCOPES = ["once", "session", "always"] as const;

export type ApprovalAllowScope = (typeof APPROVAL_ALLOW_SCOPES)[number];

export interface ApprovalFingerprintRecord {
  fingerprint: string;
  toolName: string;
  description: string;
}

export interface PersistedApprovalRule {
  kind?: ApprovalRuleKind;
  fingerprint?: string;
  pattern?: string[];
  toolName?: string;
  pathPrefix?: string;
  createdAt: string;
  createdBy: string;
  description: string;
}

export interface ApprovalRulesConfig {
  version: 1;
  rules: PersistedApprovalRule[];
}
