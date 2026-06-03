import React from "react";
import { Box, Text } from "ink";

import type { VirtualHistoryWindow } from "../hooks/use-virtual-history.js";

export interface ScrollBoxProps {
  children: React.ReactNode;
  viewportHeight: number;
  window: VirtualHistoryWindow;
}

export function ScrollBox({ children, viewportHeight, window }: ScrollBoxProps): React.ReactElement {
  const renderedRows = window.items.reduce(
    (sum, item) => sum + Math.max(0, item.rowEnd - item.rowStart),
    0
  );
  const fillRows = Math.max(0, Math.max(1, Math.floor(viewportHeight)) - renderedRows);

  return (
    <Box flexDirection="column" height={Math.max(1, Math.floor(viewportHeight))} overflowY="hidden">
      {children}
      {Array.from({ length: fillRows }, (_, index) => (
        <Text key={`scroll-fill:${index}`}> </Text>
      ))}
    </Box>
  );
}
