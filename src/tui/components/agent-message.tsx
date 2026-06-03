import React from "react";
import { Box, Text } from "ink";

import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";
import { MarkdownContent } from "./markdown-content.js";
import { Spinner } from "./spinner.js";

export interface AgentMessageProps {
  streaming?: boolean;
  text: string;
}

// Maximum number of trailing lines we keep visible while this legacy component
// streams a response. The main chat transcript now uses row-level virtualization
// in MessageStream, which keeps the active frame bounded.
const STREAMING_TAIL_LINES = 6;

function tailLines(text: string, limit: number): { content: string; truncated: boolean } {
  if (text.length === 0) {
    return { content: text, truncated: false };
  }
  const normalized = text.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  if (lines.length <= limit) {
    return { content: normalized, truncated: false };
  }
  const tail = lines.slice(-limit).join("\n");
  return { content: tail, truncated: true };
}

function AgentMessageBase({ streaming, text }: AgentMessageProps): React.ReactElement {
  const safeText = React.useMemo(() => sanitizeTerminalText(text), [text]);
  const isStreaming = streaming === true;
  const streamingTail = React.useMemo(
    () => (isStreaming ? tailLines(safeText, STREAMING_TAIL_LINES) : null),
    [isStreaming, safeText]
  );
  return (
    <Box flexDirection="column">
      <Text color={theme.agent}>
        assistant
      </Text>
      {isStreaming && streamingTail !== null ? (
        <>
          {streamingTail.truncated ? (
            <Text color={theme.muted}>
              … ({streamingTail.content.length === 0 ? "" : "showing latest lines"})
            </Text>
          ) : null}
          <Text color={theme.fg} wrap="wrap">
            {streamingTail.content}
          </Text>
        </>
      ) : (
        <MarkdownContent source={safeText} />
      )}
      <Spinner active={isStreaming} />
    </Box>
  );
}

export const AgentMessage = React.memo(AgentMessageBase);
