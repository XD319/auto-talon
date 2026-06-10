import React from "react";
import { Box, Text } from "ink";

import { APPROVAL_SCOPE_ACTIONS } from "../../approvals/approval-actions.js";
import { theme } from "../theme.js";
import type { ApprovalListItemViewModel } from "../view-models/runtime-dashboard.js";

export interface ApprovalPanelProps {
  approvals: ApprovalListItemViewModel[];
  busy: boolean;
  selectedApprovalActionIndex: number;
  selectedApprovalIndex: number;
}

export function ApprovalPanel({
  approvals,
  busy,
  selectedApprovalActionIndex,
  selectedApprovalIndex
}: ApprovalPanelProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text color={theme.panelTitle}>Pending Approvals</Text>
      {approvals.length === 0 ? (
        <Text color={theme.muted}>No approvals waiting.</Text>
      ) : (
        approvals.map((approval, index) => (
          <Box
            key={approval.approvalId}
            borderStyle="classic"
            borderColor={index === selectedApprovalIndex ? theme.selection : theme.border}
            flexDirection="column"
            marginBottom={1}
            paddingX={1}
          >
            <Text color={index === selectedApprovalIndex ? theme.selection : theme.fg}>
              {approval.toolName} [{approval.riskLevel}] task={approval.shortTaskId}
            </Text>
            <Text color={theme.muted}>{approval.summaryLine}</Text>
            <Text color={theme.muted}>expires {approval.expiresLabel}</Text>
            <Text color={theme.muted} wrap="wrap">
              {approval.taskLabel}
            </Text>
            <Text color={theme.fg} wrap="wrap">
              {approval.reason}
            </Text>
          </Box>
        ))
      )}
      {approvals.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          {APPROVAL_SCOPE_ACTIONS.map((action, index) => (
            <Text
              key={action.label}
              color={index === selectedApprovalActionIndex ? theme.emphasis : theme.muted}
            >
              {index === selectedApprovalActionIndex ? "> " : "  "}
              {index + 1}. {action.label}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={busy ? theme.warn : theme.muted}>
          {busy
            ? "Applying approval decision..."
            : "Up/Down approval, 1-4 or arrows+Enter scope, a/d legacy allow/deny."}
        </Text>
      </Box>
    </Box>
  );
}
