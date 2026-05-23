import React from "react";
import { Box, Text } from "ink";

import type { RuntimeOutputEvent } from "../../types/index.js";
import { sanitizeTerminalText } from "../text-sanitize.js";
import { theme } from "../theme.js";
import { buildTranscriptRows, type TranscriptViewerMode } from "../view-models/transcript-output.js";

export interface TranscriptViewerProps {
  events: RuntimeOutputEvent[];
  mode: TranscriptViewerMode;
  query?: string;
  title?: string;
}

export function TranscriptViewer({
  events,
  mode,
  query,
  title = "Transcript"
}: TranscriptViewerProps): React.ReactElement {
  const rows = buildTranscriptRows(events, { mode, ...(query !== undefined ? { query } : {}) });

  return (
    <Box borderColor={theme.border} borderStyle="classic" flexDirection="column" paddingX={1}>
      <Text color={theme.panelTitle}>
        {title} [{mode}] {query?.trim().length ? `search=${query}` : ""}
      </Text>
      {rows.length === 0 ? (
        <Text color={theme.muted}>No transcript rows matched.</Text>
      ) : (
        rows.slice(-80).map((row) => (
          <Text
            key={row.eventId}
            color={row.kind === "assistant" ? theme.fg : row.kind === "input" ? theme.accent : theme.muted}
            wrap="wrap"
          >
            #{row.sequence} {row.kind === "assistant" ? "assistant" : row.kind === "input" ? "user" : "activity"} {sanitizeTerminalText(row.text)}
          </Text>
        ))
      )}
    </Box>
  );
}
