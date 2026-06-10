import type { ApprovalAllowScope } from "../types/index.js";

export interface ApprovalScopeAction {
  action: "allow" | "deny";
  label: string;
  scope?: ApprovalAllowScope;
}

export const APPROVAL_SCOPE_ACTIONS: ApprovalScopeAction[] = [
  { action: "allow", label: "Allow once", scope: "once" },
  { action: "allow", label: "Allow session", scope: "session" },
  { action: "allow", label: "Allow always", scope: "always" },
  { action: "deny", label: "Deny" }
];

export function resolveApprovalScopeAction(index: number): ApprovalScopeAction | null {
  return APPROVAL_SCOPE_ACTIONS[index] ?? null;
}
