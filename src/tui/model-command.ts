import type { ConfiguredProviderEntry } from "../runtime/operations/provider-switch-service.js";
import { formatProviderSelection } from "../runtime/operations/provider-switch-service.js";
import type { ResolvedProviderConfig } from "../providers/config.js";
import { listModelAliasEntries, type ModelAliasMap } from "../providers/model-aliases.js";
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

export function formatModelListMessage(input: {
  aliases: ModelAliasMap;
  configuredProviders: ConfiguredProviderEntry[];
  current: ResolvedProviderConfig;
}): string {
  const current = formatProviderSelection(input.current);
  const lines = [`Current model: ${current}`, "", "Configured providers:"];

  if (input.configuredProviders.length === 0) {
    lines.push("- (none) Run talon provider setup <provider> to configure one.");
  } else {
    for (const provider of input.configuredProviders) {
      const selection = formatProviderSelection(provider.providerConfig);
      const marker = selection === current ? " *" : "";
      lines.push(
        `- ${provider.name} (${provider.displayName}) -> ${provider.model ?? "(default)"}${marker}`
      );
    }
  }

  const aliasEntries = listModelAliasEntries(input.aliases);
  if (aliasEntries.length > 0) {
    lines.push("", "Aliases:");
    for (const entry of aliasEntries) {
      lines.push(`- ${entry.alias} -> ${entry.target}`);
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
  return `Model switched: ${previous} -> ${input.resultSelection}${persistLabel}`;
}
