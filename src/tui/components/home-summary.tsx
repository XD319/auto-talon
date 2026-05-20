import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import { listHomeSummaryEntries, type HomeSummaryViewModel } from "../view-models/home-summary.js";

export interface HomeSummaryProps {
  selectedIndex?: number;
  summary: HomeSummaryViewModel;
}

function HomeSummaryBase({ selectedIndex = 0, summary }: HomeSummaryProps): React.ReactElement | null {
  const entries = listHomeSummaryEntries(summary);
  if (summary.title.length === 0 && summary.agenda.length === 0 && entries.length === 0) {
    return null;
  }

  return (
    <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
      {summary.title.length > 0 ? <Text color={theme.panelTitle}>{summary.title}</Text> : null}
      {summary.agenda.map((item, index) => (
        <Text key={`agenda:${index}`} color={index === 0 ? theme.fg : theme.muted} wrap="truncate-end">
          {index === 0 ? "! " : "- "}
          {item}
        </Text>
      ))}
      {entries.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.selection}>Quick actions</Text>
          {entries.map((entry, index) => (
            <Box key={entry.key} flexDirection="column">
              <Text color={index === selectedIndex ? theme.emphasis : theme.fg} wrap="truncate-end">
                {index === selectedIndex ? "> " : "  "}
                {entry.label}
              </Text>
              {entry.kind === "thread" && entry.headline !== entry.label ? (
                <Text color={index === selectedIndex ? theme.fg : theme.muted} wrap="truncate-end">
                  {entry.headline}
                </Text>
              ) : null}
              {entry.kind !== "thread" && entry.headline !== undefined ? (
                <Text color={theme.muted} wrap="truncate-end">
                  {entry.headline}
                </Text>
              ) : null}
              <Text color={theme.muted} wrap="truncate-end">
                {entry.detail}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      {summary.assistantHint.length > 0 ? (
        <Text color={theme.muted} wrap="wrap">
          {summary.assistantHint}
        </Text>
      ) : null}
    </Box>
  );
}

export const HomeSummary = React.memo(HomeSummaryBase);
