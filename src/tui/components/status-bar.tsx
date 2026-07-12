import React from "react";
import { Box, Text } from "ink";

import { theme } from "../theme.js";
import type { StatusTone } from "../ui-status.js";

export interface StatusItem {
  label: string;
  tone?: StatusTone;
}

export interface StatusBarProps {
  details?: string[];
  hints?: string[];
  metrics?: StatusItem[];
  padding?: number;
  primary: StatusItem;
  segments?: StatusItem[];
}

function StatusBarBase({
  details = [],
  hints = [],
  metrics = [],
  padding = 0,
  primary,
  segments
}: StatusBarProps): React.ReactElement {
  const renderedSegments = segments ?? buildStatusSegments({ details, hints, metrics, primary });
  return <StatusLineRow padding={padding} segments={renderedSegments} />;
}

export const StatusBar = React.memo(StatusBarBase);

export interface StatusLineRowProps {
  padding?: number;
  segments: StatusItem[];
}

function StatusLineRowBase({ padding = 0, segments }: StatusLineRowProps): React.ReactElement | null {
  if (segments.length === 0) {
    return null;
  }

  const separator = "  |  ";
  const paddingText = padding > 0 ? " ".repeat(padding) : "";

  return (
    <Box>
      <Text color={theme.muted} wrap="truncate-end">
        {paddingText.length > 0 ? <Text color={theme.muted}>{paddingText}</Text> : null}
        {segments.map((segment, index) => (
          <Text key={`${segment.label}:${index}`} color={statusToneToColor(segment.tone ?? "neutral")}>
            {index > 0 ? separator : ""}
            {segment.label}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export const StatusLineRow = React.memo(StatusLineRowBase);

export function buildStatusSegments({ details = [], hints = [], metrics = [], primary }: StatusBarProps): StatusItem[] {
  const renderedMetrics = metrics.filter((item) => item.label.length > 0);
  const renderedDetails = details.filter((item) => item.length > 0);
  return [
    primary,
    ...renderedMetrics,
    ...renderedDetails.map((label) => ({ label, tone: "muted" as const })),
    ...hints.filter((label) => label.length > 0).map((label) => ({ label, tone: "muted" as const }))
  ].filter((item) => item.label.length > 0);
}

export function normalizeStatusLabel(label: string, maxLength = 72): string {
  const compact = label.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

export function buildContextMetric(contextPercent: number): StatusItem {
  const contextTone = contextPercent < 50 ? "success" : contextPercent < 80 ? "warn" : "danger";
  return { label: `${contextPercent}%`, tone: contextTone };
}

function statusToneToColor(tone: StatusTone): string {
  switch (tone) {
    case "accent":
      return theme.accent;
    case "danger":
      return theme.danger;
    case "muted":
      return theme.muted;
    case "success":
      return theme.success;
    case "warn":
      return theme.warn;
    default:
      return theme.fg;
  }
}
