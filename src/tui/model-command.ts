import type { ConfiguredProviderEntry } from "../runtime/operations/provider-switch-service.js";
import { formatProviderSelection } from "../runtime/operations/provider-switch-service.js";
import type { ResolvedProviderConfig } from "../providers/config.js";
import { listModelAliasEntries, type ModelAliasMap } from "../providers/model-aliases.js";
import { formatEnvProviderOverrideNotice } from "../providers/provider-env.js";
import type { ProviderSwitchPersistScope } from "../runtime/operations/provider-switch-service.js";

export interface ModelCommandResult {
  kind: "error" | "list" | "switched";
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

export interface ParsedModelCommand {
  persist: ProviderSwitchPersistScope;
  selection: string | null;
}

export interface EnvOnlyProviderEntry {
  selection: string;
}

function formatProviderListSource(source: ConfiguredProviderEntry["configSource"]): string {
  switch (source) {
    case "workspace-only":
      return " [workspace-only]";
    case "workspace":
      return " [workspace override]";
    default:
      return " [user]";
  }
}

export function parseModelCommand(text: string): ParsedModelCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/model")) {
    return null;
  }

  const args = trimmed.slice("/model".length).trim();
  if (args.length === 0 || args === "list") {
    return {
      persist: "session",
      selection: null
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

  const selection = selectionTokens.join(" ").trim();
  if (selection.length === 0) {
    return {
      persist,
      selection: null
    };
  }

  return {
    persist,
    selection
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

export function formatModelListMessage(input: {
  aliases: ModelAliasMap;
  configuredProviders: ConfiguredProviderEntry[];
  current: ResolvedProviderConfig;
  envOnlyProviders?: EnvOnlyProviderEntry[];
  userProviderCount?: number;
}): string {
  const current = formatProviderSelection(input.current);
  const lines = [`Current model: ${current}`, "", "Configured providers:"];

  if (input.configuredProviders.length === 0) {
    if (input.userProviderCount === 0) {
      lines.push("- (none) No user-level providers configured.");
      lines.push("  Tip: run `talon provider setup <provider>` or `talon model` to add one globally.");
    } else {
      lines.push("- (none) Providers are configured but missing credentials in this workspace.");
      lines.push("  Tip: run `talon provider setup <provider>` or check API keys.");
    }
  } else {
    for (const provider of input.configuredProviders) {
      const selection = formatProviderSelection(provider.providerConfig);
      const marker = selection === current ? " *" : "";
      lines.push(`- ${selection} (${provider.displayName})${formatProviderListSource(provider.configSource)}${marker}`);
    }
  }

  if (input.envOnlyProviders !== undefined && input.envOnlyProviders.length > 0) {
    lines.push("", "Environment-only (not persistable via /model):");
    for (const entry of input.envOnlyProviders) {
      lines.push(`- ${entry.selection} [env]`);
    }
  }

  const aliasEntries = listModelAliasEntries(input.aliases);
  if (aliasEntries.length > 0) {
    lines.push("", "Aliases:");
    for (const entry of aliasEntries) {
      const marker = entry.target === current || entry.alias === current ? " *" : "";
      lines.push(`- ${entry.alias} -> ${entry.target}${marker}`);
    }
  }

  lines.push(
    "",
    "Switch with: /model <provider:model>",
    "Persist: /model <selection> --global (user) or --workspace (project)"
  );
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
