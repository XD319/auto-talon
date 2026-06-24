import type { Provider, TokenBudget } from "../../types/index.js";
import {
  listConfiguredProviderEntries,
  resolveProviderConfigForProvider,
  resolveProviderConfigForSwitch,
  resolveProviderSelectionWithAliases,
  useProviderConfig,
  type ProviderConfigScope,
  type ProviderListSource,
  type ResolvedProviderConfig
} from "../../providers/config.js";
import { createProvider } from "../../providers/provider-factory.js";
import { enrichProviderContextFromApi } from "../../providers/context-window-enrichment.js";
import { isProviderSwitchable } from "../../providers/provider-switchable.js";
import { resolveEffectiveContextWindow } from "../bootstrap.js";

export type ProviderSwitchPersistScope = "session" | "user" | "workspace";

export interface SwitchProviderInput {
  cwd?: string;
  persist: ProviderSwitchPersistScope;
  selection: string;
  tokenBudget: TokenBudget;
  tokenBudgetInputLimitExplicit: boolean;
}

export interface SwitchProviderResult {
  persistedScope: ProviderSwitchPersistScope | null;
  provider: Provider;
  providerConfig: ResolvedProviderConfig;
  selection: string;
  tokenBudget: TokenBudget;
}

export interface ConfiguredProviderEntry {
  configSource: ProviderListSource;
  displayName: string;
  model: string | null;
  name: string;
  providerConfig: ResolvedProviderConfig;
}

export function formatProviderSelection(config: ResolvedProviderConfig): string {
  if (config.model !== null && config.model.length > 0) {
    return `${config.name}:${config.model}`;
  }
  return config.name;
}

export { isProviderSwitchable } from "../../providers/provider-switchable.js";

export function listConfiguredProviders(cwd: string): ConfiguredProviderEntry[] {
  const entries: ConfiguredProviderEntry[] = [];

  for (const providerEntry of listConfiguredProviderEntries(cwd)) {
    let config: ResolvedProviderConfig;
    try {
      config = resolveProviderConfigForProvider(cwd, providerEntry.name);
    } catch {
      continue;
    }
    if (!isProviderSwitchable(config)) {
      continue;
    }
    entries.push({
      configSource: providerEntry.source,
      displayName: config.displayName,
      model: config.model,
      name: config.name,
      providerConfig: config
    });
  }

  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function switchProviderRuntime(
  input: SwitchProviderInput
): Promise<SwitchProviderResult> {
  const cwd = input.cwd ?? process.cwd();
  const resolvedSelection = resolveProviderSelectionWithAliases(input.selection, cwd);
  const providerConfig = resolveProviderConfigForSwitch(cwd, resolvedSelection);

  if (!isProviderSwitchable(providerConfig)) {
    throw new Error(
      `Provider "${providerConfig.name}" is not configured. Run talon provider setup ${providerConfig.name} first.`
    );
  }

  let persistedScope: ProviderSwitchPersistScope | null = null;
  if (input.persist === "user" || input.persist === "workspace") {
    const scope: ProviderConfigScope = input.persist;
    useProviderConfig(resolvedSelection, { cwd, scope });
    persistedScope = input.persist;
  }

  const probeProvider = createProvider(providerConfig);
  const enrichedConfig = await enrichProviderContextFromApi(probeProvider, providerConfig, {
    tokenBudgetInputLimitExplicit: input.tokenBudgetInputLimitExplicit
  });
  const effective = resolveEffectiveContextWindow(enrichedConfig, {
    tokenBudget: input.tokenBudget,
    tokenBudgetInputLimitExplicit: input.tokenBudgetInputLimitExplicit
  });
  const provider = createProvider(effective.provider);
  const tokenBudget: TokenBudget = {
    ...input.tokenBudget,
    ...effective.tokenBudget
  };

  return {
    persistedScope,
    provider,
    providerConfig: effective.provider,
    selection: formatProviderSelection(effective.provider),
    tokenBudget
  };
}
