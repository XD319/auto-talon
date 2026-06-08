import React from "react";
import { Box, Text } from "ink";

import type { SessionIndexEntry } from "../../types/index.js";
import { theme } from "../theme.js";
import type { WelcomeHomeViewModel } from "../view-models/welcome-home.js";
import {
  computePickerViewport,
  extractPreviewMessages,
  formatPreviewLine
} from "../view-models/session-picker-model.js";
import type { ChatMessage } from "../view-models/chat-messages.js";

export type SessionBrowserMode = "welcome" | "picker";

export interface SessionBrowserProps {
  entries: SessionIndexEntry[];
  filter: string;
  mode: SessionBrowserMode;
  previewMessages: ChatMessage[] | null;
  previewOpen: boolean;
  selectedIndex: number;
  welcomeSummary?: WelcomeHomeViewModel;
}

export function SessionBrowser({
  entries,
  filter,
  mode,
  previewMessages,
  previewOpen,
  selectedIndex,
  welcomeSummary
}: SessionBrowserProps): React.ReactElement {
  if (mode === "welcome" && welcomeSummary !== undefined) {
    return (
      <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
        <Text color={theme.panelTitle}>Welcome</Text>
        <Text color={theme.fg}>Ask AutoTalon to inspect, change, or explain your workspace.</Text>
        {welcomeSummary.entries.length > 0 ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.selection}>Recent conversations</Text>
            {welcomeSummary.entries.map((entry, index) => (
              <Box key={entry.key} flexDirection="column">
                <Text color={index === selectedIndex ? theme.emphasis : theme.fg} wrap="truncate-end">
                  {index === selectedIndex ? "> " : "  "}
                  {entry.label}
                </Text>
                <Text color={theme.muted} wrap="truncate-end">
                  {entry.detail}
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.selection}>Try asking</Text>
            {welcomeSummary.examples.map((example) => (
              <Text key={example} color={theme.muted} wrap="wrap">
                - {example}
              </Text>
            ))}
          </Box>
        )}
        <Text color={theme.muted} wrap="wrap">
          {welcomeSummary.hint}
        </Text>
      </Box>
    );
  }

  const viewport = computePickerViewport(entries, selectedIndex);

  return (
    <Box borderStyle="round" flexDirection="column" marginBottom={1} paddingX={1}>
      <Text bold>Sessions</Text>
      <Text color={theme.muted}>
        Up/Down + Enter select | Esc cancel | Type to filter | P preview
      </Text>
      {filter.length > 0 ? (
        <Text color={theme.selection}>
          Filter: {filter}
        </Text>
      ) : null}
      {entries.length === 0 ? (
        <Text color={theme.muted}>No sessions matched.</Text>
      ) : (
        <>
          {viewport.total > viewport.visibleEntries.length ? (
            <Text color={theme.muted}>
              Showing {viewport.start + 1}-{viewport.end} of {viewport.total}
            </Text>
          ) : null}
          {viewport.visibleEntries.map((entry, localIndex) => {
            const index = viewport.start + localIndex;
            const selected = index === selectedIndex;
            return (
              <Text key={entry.sessionId} {...(selected ? { color: theme.emphasis } : {})}>
                {selected ? "> " : "  "}
                {entry.sessionId.slice(0, 8)} | {entry.title} [{entry.source}] {entry.messageCount} msgs
                {entry.preview !== null ? ` - ${entry.preview}` : ""}
              </Text>
            );
          })}
        </>
      )}
      {previewOpen && previewMessages !== null ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold color={theme.panelTitle}>
            Preview
          </Text>
          {extractPreviewMessages(previewMessages).map((message) => (
            <Text key={message.id} color={theme.muted} wrap="wrap">
              {formatPreviewLine(message)}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
