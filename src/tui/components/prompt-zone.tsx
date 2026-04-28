import React from "react";
import { Box, Text } from "ink";

import type { ApprovalRecord, ClarifyPromptRecord, ToolCallRecord } from "../../types/index.js";
import { theme } from "../theme.js";

export interface ApprovalPromptViewModel {
  approval: ApprovalRecord;
  selectedIndex: number;
  toolCall: ToolCallRecord | null;
}

export interface ClarifyPromptViewModel {
  customActive: boolean;
  customLines: string[];
  prompt: ClarifyPromptRecord;
  selectedIndex: number;
}

export interface PromptZoneProps {
  approvalPrompt?: ApprovalPromptViewModel | null;
  clarifyPrompt?: ClarifyPromptViewModel | null;
}

const APPROVAL_ACTIONS = ["Allow once", "Allow session", "Allow always", "Deny"];

export function PromptZone({ approvalPrompt, clarifyPrompt }: PromptZoneProps): React.ReactElement | null {
  if (clarifyPrompt !== undefined && clarifyPrompt !== null) {
    return <ClarifyPromptCard {...clarifyPrompt} />;
  }
  if (approvalPrompt !== undefined && approvalPrompt !== null) {
    return <ApprovalPromptCard {...approvalPrompt} />;
  }
  return null;
}

function ApprovalPromptCard({ approval, selectedIndex, toolCall }: ApprovalPromptViewModel): React.ReactElement {
  const commandPreview =
    typeof toolCall?.input["command"] === "string" ? toolCall.input["command"] : null;
  const pathPreview =
    typeof toolCall?.input["path"] === "string"
      ? toolCall.input["path"]
      : extractReasonLine(approval.reason, "Resolved path:");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn}>Approval Prompt</Text>
      <Text>
        <Text color={theme.fg}>{approval.toolName}</Text>
        <Text color={theme.muted}> [{toolCall?.riskLevel ?? "unknown"}]</Text>
      </Text>
      {pathPreview !== null ? <Text color={theme.muted}>path {pathPreview}</Text> : null}
      {commandPreview !== null ? <Text color={theme.muted}>command {commandPreview}</Text> : null}
      <Text color={theme.muted}>reason {approval.reason.split("\n")[0] ?? approval.reason}</Text>
      <Text color={theme.muted}>keys 1-4, arrows, Enter, Ctrl+C deny</Text>
      <Box marginTop={1} flexDirection="column">
        {APPROVAL_ACTIONS.map((label, index) => (
          <Text key={label} color={index === selectedIndex ? theme.emphasis : theme.fg}>
            {index === selectedIndex ? "> " : "  "}
            {index + 1}. {label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function ClarifyPromptCard({
  customActive,
  customLines,
  prompt,
  selectedIndex
}: ClarifyPromptViewModel): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn}>Clarify Prompt</Text>
      <Text color={theme.fg}>{prompt.question}</Text>
      {prompt.reason !== null ? <Text color={theme.muted}>reason {prompt.reason}</Text> : null}
      <Text color={theme.muted}>arrows choose, Tab custom, Enter submit, Ctrl+C cancel</Text>
      <Box marginTop={1} flexDirection="column">
        {prompt.options.map((option, index) => (
          <Text key={option.id} color={!customActive && index === selectedIndex ? theme.emphasis : theme.fg}>
            {!customActive && index === selectedIndex ? "> " : "  "}
            {option.label}
          </Text>
        ))}
      </Box>
      {prompt.allowCustomAnswer ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={customActive ? theme.selection : theme.muted}>
            {customActive ? "> " : "  "}
            custom {prompt.placeholder ?? "Type your answer"}
          </Text>
          {customActive ? customLines.map((line, index) => <Text key={`custom:${index}`}>{line}</Text>) : null}
        </Box>
      ) : null}
    </Box>
  );
}

function extractReasonLine(reason: string, prefix: string): string | null {
  const line = reason.split("\n").find((entry) => entry.startsWith(prefix));
  if (line === undefined) {
    return null;
  }
  return line.slice(prefix.length).trim();
}
