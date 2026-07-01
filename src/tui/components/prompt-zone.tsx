import React from "react";
import { Box, Text } from "ink";

import { APPROVAL_SCOPE_ACTIONS } from "../../approvals/approval-actions.js";
import { buildApprovalPromptContext } from "../../approvals/approval-prompt-view-model.js";
import type { ApprovalRecord, ClarifyPromptRecord, ToolCallRecord } from "../../types/index.js";
import { clarifyPromptHint } from "../view-models/clarify-prompt-actions.js";
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
  questionCount?: number;
  questionIndex?: number;
  selectedOptionIds?: string[];
  selectedIndex: number;
}

export interface PromptZoneProps {
  approvalPrompt?: ApprovalPromptViewModel | null;
  clarifyPrompt?: ClarifyPromptViewModel | null;
}

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
  const context = buildApprovalPromptContext(approval, toolCall);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn}>Tool Permission</Text>
      <Text>
        <Text color={theme.fg}>{context.toolName}</Text>
        <Text color={theme.muted}> [{context.riskLevel}]</Text>
        {context.riskTags.length > 0 ? (
          <Text color={theme.danger}> {context.riskTags.join(" ")}</Text>
        ) : null}
      </Text>
      <Text color={theme.fg}>{context.summaryLine}</Text>
      {context.detailLines.map((line) => (
        <Text key={line} color={theme.muted}>
          {line}
        </Text>
      ))}
      <Text color={theme.muted}>reason {approval.reason.split("\n")[0] ?? approval.reason}</Text>
      <Text color={theme.muted}>keys 1-4, arrows, Enter, Ctrl+C deny</Text>
      <Box marginTop={1} flexDirection="column">
        {APPROVAL_SCOPE_ACTIONS.map((action, index) => (
          <Text key={action.label} color={index === selectedIndex ? theme.emphasis : theme.fg}>
            {index === selectedIndex ? "> " : "  "}
            {index + 1}. {action.label}
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
  questionCount,
  questionIndex,
  selectedOptionIds = [],
  selectedIndex
}: ClarifyPromptViewModel): React.ReactElement {
  const currentQuestion = questionIndex === undefined ? null : (prompt.questions[questionIndex] ?? null);
  const hintQuestion =
    currentQuestion ??
    ({
      allowCustomAnswer: prompt.allowCustomAnswer,
      multiSelect: false,
      options: prompt.options,
      placeholder: prompt.placeholder,
      question: prompt.question
    } as const);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
      <Text color={theme.warn}>
        Question
        {questionCount !== undefined && questionCount > 1 && questionIndex !== undefined
          ? ` ${questionIndex + 1}/${questionCount}`
          : ""}
      </Text>
      <Text color={theme.fg}>{prompt.question}</Text>
      {prompt.reason !== null ? <Text color={theme.muted}>reason {prompt.reason}</Text> : null}
      <Text color={theme.muted}>{clarifyPromptHint(hintQuestion)}</Text>
      <Box marginTop={1} flexDirection="column">
        {prompt.options.map((option, index) => (
          <Box key={option.id} flexDirection="column">
            <Text color={!customActive && index === selectedIndex ? theme.emphasis : theme.fg}>
              {!customActive && index === selectedIndex ? "> " : "  "}
              {selectedOptionIds.includes(option.id) ? "[x] " : "    "}
              {option.label}
            </Text>
            {option.description !== undefined ? (
              <Text color={theme.muted}>    {option.description}</Text>
            ) : null}
            {option.preview !== undefined ? <Text color={theme.muted}>    {option.preview}</Text> : null}
          </Box>
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
