import React from "react";
import { Text } from "ink";

import { theme } from "../theme.js";
import type { VirtualHistoryWindow } from "../hooks/use-virtual-history.js";
import { ScrollBox } from "./scroll-box.js";

export interface TranscriptPaneProps {
  viewportHeight: number;
  window: VirtualHistoryWindow;
}

export function TranscriptPane({ viewportHeight, window }: TranscriptPaneProps): React.ReactElement {
  if (window.totalHeight === 0) {
    return (
      <ScrollBox viewportHeight={viewportHeight} window={window}>
        <Text color={theme.muted}>No conversation yet.</Text>
      </ScrollBox>
    );
  }

  return (
    <ScrollBox viewportHeight={viewportHeight} window={window}>
      {window.items.flatMap((item) =>
        item.measurement.rows.slice(item.rowStart, item.rowEnd).map((row) => (
          <Text
            key={`${item.message?.id ?? item.measurement.id}:${row.id}`}
            {...(row.bold === true ? { bold: true } : {})}
            color={row.color ?? theme.fg}
            wrap="truncate-end"
          >
            {row.text.length > 0 ? row.text : " "}
          </Text>
        ))
      )}
    </ScrollBox>
  );
}
