import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import { listHomeSummaryEntries, type HomeSummaryViewModel } from "../view-models/home-summary.js";

export interface HomeSummaryProps {
  selectedIndex?: number;
  summary: HomeSummaryViewModel;
}

function HomeSummaryBase({ selectedIndex = 0, summary }: HomeSummaryProps): React.ReactElement {
  const entries = listHomeSummaryEntries(summary);

  return (
    <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
      <Text color={theme.panelTitle}>{summary.title}</Text>
      {summary.agenda.map((item, index) => (
        <Text key={`agenda:${index}`} color={index === 0 ? theme.fg : theme.muted} wrap="wrap">
          {index === 0 ? "> " : "- "}
          {item}
        </Text>
      ))}
      {entries.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.selection}>Recommended next steps</Text>
          {entries.map((entry, index) => (
            <Box key={entry.key} flexDirection="column">
              <Text color={index === selectedIndex ? theme.emphasis : theme.fg}>
                {index === selectedIndex ? "> " : "  "}
                {entry.label}
              </Text>
              {entry.kind === "thread" && entry.headline !== entry.label ? (
                <Text color={index === selectedIndex ? theme.fg : theme.muted} wrap="wrap">
                  {entry.headline}
                </Text>
              ) : null}
              {entry.kind !== "thread" && entry.headline !== undefined ? (
                <Text color={theme.muted} wrap="wrap">
                  {entry.headline}
                </Text>
              ) : null}
              <Text color={theme.muted} wrap="wrap">
                {entry.detail}
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Text color={theme.muted} wrap="wrap">
        {summary.assistantHint}
      </Text>
    </Box>
  );
}

export const HomeSummary = React.memo(HomeSummaryBase);
