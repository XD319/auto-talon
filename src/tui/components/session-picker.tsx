import React from "react";
import { Box, Text } from "ink";

import type { SessionIndexEntry } from "../../types/index.js";
import { theme } from "../theme.js";

export interface SessionPickerProps {
  entries: SessionIndexEntry[];
  selectedIndex: number;
}

export function SessionPicker({ entries, selectedIndex }: SessionPickerProps): React.ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column" marginBottom={1} paddingX={1}>
      <Text bold>Sessions</Text>
      <Text color={theme.muted}>Up/Down + Enter select | Esc cancel</Text>
      {entries.length === 0 ? (
        <Text color={theme.muted}>No sessions yet.</Text>
      ) : (
        entries.slice(0, 12).map((entry, index) => {
          const selected = index === selectedIndex;
          return (
            <Text key={entry.sessionId} {...(selected ? { color: theme.emphasis } : {})}>
              {selected ? "> " : "  "}
              {entry.sessionId.slice(0, 8)} | {entry.title} [{entry.source}] {entry.messageCount} msgs
              {entry.preview !== null ? ` - ${entry.preview}` : ""}
            </Text>
          );
        })
      )}
    </Box>
  );
}
