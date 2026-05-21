import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { WelcomeHomeViewModel } from "../view-models/welcome-home.js";

export interface WelcomeHomeProps {
  selectedIndex?: number;
  summary: WelcomeHomeViewModel;
}

function WelcomeHomeBase({ selectedIndex = 0, summary }: WelcomeHomeProps): React.ReactElement {
  return (
    <Box borderStyle="classic" borderColor={theme.border} flexDirection="column" paddingX={1}>
      <Text color={theme.panelTitle}>Welcome</Text>
      <Text color={theme.fg}>Ask AutoTalon to inspect, change, or explain your workspace.</Text>
      {summary.entries.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.selection}>Recent conversations</Text>
          {summary.entries.map((entry, index) => (
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
          {summary.examples.map((example) => (
            <Text key={example} color={theme.muted} wrap="wrap">
              - {example}
            </Text>
          ))}
        </Box>
      )}
      <Text color={theme.muted} wrap="wrap">
        {summary.hint}
      </Text>
    </Box>
  );
}

export const WelcomeHome = React.memo(WelcomeHomeBase);
