import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";

export interface SessionRecapProps {
  recapText: string;
}

export function SessionRecap({ recapText }: SessionRecapProps): React.ReactElement {
  const lines = recapText.split("\n");
  return (
    <Box borderStyle="round" flexDirection="column" marginBottom={1} paddingX={1}>
      <Text bold color={theme.panelTitle}>
        Session recap
      </Text>
      <Text color={theme.muted}>Send a message or press Esc to dismiss</Text>
      {lines.map((line, index) => (
        <Text key={`recap-line-${index}`} color={line.startsWith("- ") ? theme.fg : theme.emphasis} wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
}
