export const APPROVAL_ALLOW_SCOPES = ["once", "session", "always"] as const;

export type ApprovalAllowScope = (typeof APPROVAL_ALLOW_SCOPES)[number];

export interface ApprovalFingerprintRecord {
  fingerprint: string;
  toolName: string;
  description: string;
}

export interface PersistedApprovalRule extends ApprovalFingerprintRecord {
  createdAt: string;
  createdBy: string;
}

export interface ApprovalRulesConfig {
  version: 1;
  rules: PersistedApprovalRule[];
}
