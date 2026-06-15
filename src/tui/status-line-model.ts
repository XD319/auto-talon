import type { ResolvedProviderConfig } from "../providers/config.js";
import type { TuiStatusLineConfig, ResolvedStatusLineFields } from "../runtime/tui-status-line-config.js";
import { resolveStatusLineFields } from "../runtime/tui-status-line-config.js";
import type { TuiInteractionMode } from "../types/runtime.js";
import type { StatusItem } from "./components/status-bar.js";
import { formatGitBranchLabel, type GitBranchStatus } from "./workspace-git-status.js";
import type { StatusTone, UiRunState } from "./ui-status.js";

export interface BuiltinStatusLineInput {
  config: TuiStatusLineConfig;
  gitStatus: GitBranchStatus | null;
  inputLimit: number;
  interactionMode: TuiInteractionMode;
  provider: ResolvedProviderConfig;
  reservedOutput: number;
  tokenHud: {
    compactedCount: number;
    contextPercent: number;
    estimatedCostUsd: number;
    inputTokens: number;
    microPrunedCount: number;
  };
}

export interface ActivityStatusInput {
  pendingApprovalToolName: string | null;
  pendingClarify: boolean;
  primaryLabel: string;
  primaryTone: StatusTone;
  providerLabel?: string;
  runState: UiRunState;
}

export function buildBuiltinStatusSegments(input: BuiltinStatusLineInput): StatusItem[] {
  const fields = resolveStatusLineFields(input.config);
  const segments: StatusItem[] = [];

  if (fields.showModel) {
    segments.push({ label: formatModelShortName(input.provider), tone: "muted" });
  }
  if (fields.showMode) {
    segments.push({ label: formatInteractionMode(input.interactionMode), tone: "muted" });
  }
  if (fields.showBranch && input.gitStatus !== null) {
    segments.push({ label: formatGitBranchLabel(input.gitStatus), tone: "muted" });
  }
  if (fields.showTokens) {
    segments.push({
      label: formatTokensStatusField(
        input.tokenHud.contextPercent,
        input.tokenHud.inputTokens,
        input.inputLimit,
        input.reservedOutput,
        {
          compactedCount: input.tokenHud.compactedCount,
          microPrunedCount: input.tokenHud.microPrunedCount
        }
      ),
      tone: tokensTone(input.tokenHud.contextPercent)
    });
  }
  if (fields.showCost) {
    const costLabel = formatCostStatusField(input.tokenHud.estimatedCostUsd);
    if (costLabel !== null) {
      segments.push({ label: costLabel, tone: "muted" });
    }
  }

  return segments;
}

export function buildActivityStatusItem(input: ActivityStatusInput): StatusItem | null {
  if (input.pendingApprovalToolName !== null) {
    return { label: `approval: ${input.pendingApprovalToolName}`, tone: "warn" };
  }
  if (input.pendingClarify) {
    return { label: "clarify", tone: "warn" };
  }
  if (input.runState === "waiting_approval") {
    return { label: "waiting approval", tone: "warn" };
  }
  if (input.runState === "waiting_clarification") {
    return { label: "waiting clarification", tone: "warn" };
  }
  if (input.runState === "running") {
    return {
      label: mapRunStateLabel(input.runState, input.primaryLabel),
      tone: input.primaryTone === "muted" ? "accent" : input.primaryTone
    };
  }
  if (input.runState === "succeeded") {
    return { label: "completed", tone: "success" };
  }
  if (input.runState === "failed") {
    return { label: "failed", tone: "danger" };
  }
  if (input.runState === "interrupted") {
    return { label: "interrupted", tone: "warn" };
  }
  return null;
}

export function formatInteractionMode(mode: TuiInteractionMode): string {
  switch (mode) {
    case "acceptEdits":
      return "accept-edits";
    case "plan":
      return "plan";
    default:
      return "default";
  }
}

export function formatModelShortName(provider: ResolvedProviderConfig): string {
  const model = provider.model?.trim();
  if (model !== undefined && model.length > 0) {
    return model;
  }
  return provider.displayName.length > 0 ? provider.displayName : provider.name;
}

export function mapRunStateLabel(runState: UiRunState, providerLabel?: string): string {
  if (runState === "idle") {
    return "ready";
  }
  if (runState === "running") {
    const compact = providerLabel?.replace(/\s+/gu, " ").trim() ?? "";
    if (compact.length > 0 && compact !== "running task" && compact !== "running") {
      return compact.length <= 48 ? compact : `${compact.slice(0, 45)}...`;
    }
    return "running";
  }
  return runState.replace(/_/gu, " ");
}

export function formatTokensStatusField(
  contextPercent: number,
  inputTokens: number,
  inputLimit: number,
  reservedOutput: number,
  compaction?: { compactedCount?: number; microPrunedCount?: number }
): string {
  const parts: string[] = [`${contextPercent}%`];
  const usableWindow = Math.max(inputLimit - reservedOutput, 1);
  if (inputTokens > 0) {
    parts.push(`${compactTokenCount(inputTokens)}/${compactTokenCount(usableWindow)}`);
  }

  const compactionParts: string[] = [];
  if ((compaction?.microPrunedCount ?? 0) > 0) {
    compactionParts.push(`micro-pruned: ${compaction?.microPrunedCount}`);
  }
  if ((compaction?.compactedCount ?? 0) > 0) {
    compactionParts.push(`compacted: ${compaction?.compactedCount}`);
  }
  const suffix = compactionParts.length > 0 ? ` (${compactionParts.join(", ")})` : "";
  return `${parts.join(" · ")}${suffix}`;
}

export function formatCostStatusField(estimatedCostUsd: number): string | null {
  if (estimatedCostUsd < 0.0001) {
    return null;
  }
  return `~$${estimatedCostUsd.toFixed(3)}`;
}

function compactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}

function tokensTone(contextPercent: number): StatusTone {
  if (contextPercent < 50) {
    return "success";
  }
  if (contextPercent < 80) {
    return "warn";
  }
  return "danger";
}

export type { ResolvedStatusLineFields };
