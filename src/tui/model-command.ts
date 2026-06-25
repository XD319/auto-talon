import type { ResolvedProviderConfig } from "../providers/config.js";
import type { ModelSelectionView } from "../runtime/operations/model-selection-service.js";
import type { ProviderSwitchPersistScope } from "../runtime/operations/provider-switch-service.js";
import { formatProviderSelection } from "../runtime/operations/provider-switch-service.js";
import { formatEnvProviderOverrideNotice } from "../providers/provider-env.js";
import {
  formatAuxiliaryFallbackSection,
  formatAuxiliarySlotSection,
  formatConfiguredModelSection,
  formatEnvironmentOnlyModelSection,
  formatFallbackProviderSection,
  formatFallbackStatusSection,
  formatModelAliasSection
} from "../presentation/model-formatters.js";

export interface ModelCommandResult {
  kind: "cleared" | "error" | "list" | "status" | "switched";
  message: string;
  persist?: ProviderSwitchPersistScope | null;
  providerConfig?: ResolvedProviderConfig;
  selection?: string;
  tokenBudget?: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
}

export type ParsedModelCommand =
  | { action: "list"; persist: ProviderSwitchPersistScope }
  | { action: "status"; persist: ProviderSwitchPersistScope }
  | { action: "clear"; persist: "session" }
  | {
      action: "switch";
      index: number | null;
      persist: ProviderSwitchPersistScope;
      selection: string | null;
    };

export function parseModelCommand(text: string): ParsedModelCommand | null {
  const trimmed = text.trim();
  if (trimmed !== "/model" && !trimmed.startsWith("/model ")) {
    return null;
  }

  const args = trimmed.slice("/model".length).trim();
  if (args.length === 0) {
    return {
      action: "list",
      persist: "session"
    };
  }

  const tokens = args.split(/\s+/u);
  let persist: ProviderSwitchPersistScope = "session";
  const selectionTokens: string[] = [];

  for (const token of tokens) {
    if (token === "--global") {
      persist = "user";
      continue;
    }
    if (token === "--workspace") {
      persist = "workspace";
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown /model flag "${token}". Supported flags: --global, --workspace`);
    }
    selectionTokens.push(token);
  }

  if (selectionTokens.length === 0) {
    return {
      action: "list",
      persist
    };
  }

  if (selectionTokens.length === 1) {
    const command = selectionTokens[0]!;
    if (command === "list") {
      return {
        action: "list",
        persist
      };
    }
    if (command === "status") {
      return {
        action: "status",
        persist
      };
    }
    if (command === "default") {
      if (persist !== "session") {
        throw new Error("/model default clears the current session override and does not accept persist flags.");
      }
      return {
        action: "clear",
        persist: "session"
      };
    }
    const index = Number(command);
    if (Number.isInteger(index) && index > 0) {
      return {
        action: "switch",
        index,
        persist,
        selection: null
      };
    }
  }

  const selection = selectionTokens.join(" ").trim();
  return {
    action: "switch",
    index: null,
    persist,
    selection: selection.length === 0 ? null : selection
  };
}

export function formatFlagsOnlyModelHint(persist: ProviderSwitchPersistScope): string {
  const scopeLabel =
    persist === "user" ? "--global" : persist === "workspace" ? "--workspace" : "session";
  return [
    `Persist flag (${scopeLabel}) requires a model selection.`,
    "Example: /model deepseek:deepseek-chat --global",
    "Run /model to list configured providers."
  ].join("\n");
}

export function formatModelListMessage(view: ModelSelectionView): string {
  const credential = resolveCredentialSummary(view);
  const fallback = resolveFallbackSummary(view);
  const lines = [
    `Current model: ${view.current.selection}`,
    `Source: ${formatModelSource(view.current.source)}${view.current.strict ? " (strict)" : ""}`,
    "",
    ...formatConfiguredModelSection(view),
    ...formatModelAliasSection(view),
    "",
    `Credential: ${credential.credentialStatus} (${credential.activeCredentialId ?? "-"})`,
    `Fallback: ${fallback.main.length === 0 ? "(none)" : fallback.main.join(" -> ")}`,
    `Auxiliary: ${formatAuxiliarySummary(view.auxiliary)}`,
    "",
    "Switch with: /model <number> or /model <provider:model>",
    "Clear session override: /model default",
    "Details: /model status"
  ];
  return lines.join("\n");
}

export function formatModelStatusMessage(view: ModelSelectionView): string {
  const credential = resolveCredentialSummary(view);
  const fallback = resolveFallbackSummary(view);
  const lines = [
    `Current model: ${view.current.selection}`,
    `Source: ${formatModelSource(view.current.source)}${view.current.strict ? " (strict)" : ""}`,
    `Provider: ${view.current.providerName}`,
    `Model: ${view.current.model ?? "-"}`,
    `Base URL: ${view.current.baseUrl ?? "-"}`,
    `Context Window Tokens: ${view.current.contextWindowTokens ?? "-"}`,
    `Credential: ${credential.credentialStatus} (${credential.activeCredentialId ?? "-"})`,
    `Session: ${view.session.sessionId ?? "-"}`,
    `Session override: ${view.session.modelSelection?.selection ?? "-"}`,
    `Routing mode: ${view.routing.mode}`,
    "",
    ...formatConfiguredModelSection(view),
    ...formatEnvironmentOnlyModelSection(view),
    ...formatModelAliasSection(view),
    ...formatFallbackProviderSection(fallback),
    ...formatAuxiliaryFallbackSection(fallback),
    ...formatFallbackStatusSection(fallback),
    ...formatAuxiliarySlotSection(view.auxiliary, { emptyLabel: "- (none)" })
  ];

  return lines.join("\n");
}

export function formatModelSwitchMessage(input: {
  persist: ProviderSwitchPersistScope;
  previous: ResolvedProviderConfig;
  resultSelection: string;
}): string {
  const previous = formatProviderSelection(input.previous);
  const persistLabel =
    input.persist === "user"
      ? " (saved to user config)"
      : input.persist === "workspace"
        ? " (saved to workspace config)"
        : " (session only)";
  const lines = [`Model switched: ${previous} -> ${input.resultSelection}${persistLabel}`];
  if (input.persist === "user" || input.persist === "workspace") {
    const envNotice = formatEnvProviderOverrideNotice();
    if (envNotice !== null) {
      lines.push(envNotice);
    }
  }
  return lines.join("\n");
}

export function formatModelClearMessage(input: { currentSelection: string; sessionId: string }): string {
  return [
    `Session model override cleared: ${input.sessionId}`,
    `Current model: ${input.currentSelection}`
  ].join("\n");
}

function resolveCredentialSummary(view: ModelSelectionView): ModelSelectionView["current"]["credential"] {
  return (view.current as { credential?: ModelSelectionView["current"]["credential"] }).credential ?? {
    activeCredentialId: null,
    availableCredentialIds: [],
    credentialCount: 0,
    credentialSource: null,
    credentialStatus: "missing"
  };
}

function resolveFallbackSummary(view: ModelSelectionView): ModelSelectionView["fallback"] {
  return (view as { fallback?: ModelSelectionView["fallback"] }).fallback ?? {
    auxiliary: {},
    main: (view as { fallbackProviders?: string[] }).fallbackProviders ?? [],
    status: {
      activeFallback: null,
      lastFailure: null,
      updatedAt: null
    }
  };
}
function formatModelSource(source: string): string {
  switch (source) {
    case "session_user":
      return "session override";
    case "user":
      return "user config";
    case "workspace":
      return "workspace config";
    case "routing":
      return "routing providers";
    case "env":
      return "environment";
    case "runtime":
      return "runtime";
    default:
      return source;
  }
}

function formatAuxiliarySummary(auxiliary: Record<string, string>): string {
  const entries = Object.entries(auxiliary);
  if (entries.length === 0) {
    return "(none)";
  }
  return entries.map(([slot, selection]) => `${slot}=${selection}`).join(", ");
}
