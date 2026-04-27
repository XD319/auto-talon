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
  primary: StatusItem;
}

function StatusBarBase({ details = [], hints = [], metrics = [], primary }: StatusBarProps): React.ReactElement {
  const separator = "  |  ";
  const segments = buildStatusSegments({ details, hints, metrics, primary });

  return (
    <Box>
      <Text color={theme.muted} wrap="truncate-end">
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

export const StatusBar = React.memo(StatusBarBase);

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

export function buildTokenMetrics(
  inputTokens: number,
  outputTokens: number,
  contextPercent: number,
  estimatedCostUsd: number
): StatusItem[] {
  const contextTone = contextPercent < 50 ? "success" : contextPercent < 80 ? "warn" : "danger";
  const costLabel = estimatedCostUsd < 0.000_5 ? "~$0.00" : `~$${estimatedCostUsd.toFixed(4)}`;
  return [
    { label: `in ${inputTokens}`, tone: "muted" },
    { label: `out ${outputTokens}`, tone: "muted" },
    { label: `ctx ${contextPercent}%`, tone: contextTone },
    { label: costLabel, tone: contextPercent >= 80 ? "warn" : "muted" }
  ];
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
