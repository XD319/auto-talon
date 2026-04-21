import React from "react";
import { Box, Text } from "ink";

export interface InputBoxProps {
  busy: boolean;
  hasPendingApproval: boolean;
  lines: string[];
  value: string;
}

function InputBoxBase({ busy, hasPendingApproval, lines, value }: InputBoxProps): React.ReactElement {
  const placeholder = getPlaceholderText(busy, hasPendingApproval);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {value.length === 0 ? (
        <Text color="gray">{placeholder}</Text>
      ) : (
        lines.map((line, index) => <Text key={`line:${index}`}>{line}</Text>)
      )}
    </Box>
  );
}

export const InputBox = React.memo(InputBoxBase);

function getPlaceholderText(busy: boolean, hasPendingApproval: boolean): string {
  if (hasPendingApproval) {
    return "Approval pending: press a to allow, d to deny.";
  }
  if (busy) {
    return "Agent is running...";
  }
  return "Type a message... (Enter send, Alt+Enter/Ctrl+J newline, /help /status /title)";
}
