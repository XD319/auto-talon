import type { TuiAppConfig, TuiRuntimeService } from "./runtime-api.js";
import type { ResolvedProviderConfig } from "../providers/config.js";
import {
  listEnvOnlyProviderSelections,
  listUserConfiguredProviderNames,
  resolveMergedModelAliases
} from "../providers/config.js";
import type { ProviderSwitchPersistScope } from "../runtime/operations/provider-switch-service.js";
import { formatProviderSelection } from "../runtime/operations/provider-switch-service.js";
import {
  formatFlagsOnlyModelHint,
  formatModelListMessage,
  formatModelSwitchMessage,
  parseModelCommand,
  type ModelCommandResult
} from "./model-command.js";

export async function handleModelCommand(input: {
  busy: boolean;
  cwd: string;
  currentProvider: ResolvedProviderConfig;
  pendingApproval: boolean;
  pendingClarify: boolean;
  service: Pick<TuiRuntimeService, "listConfiguredProviders" | "switchProvider">;
  text: string;
}): Promise<ModelCommandResult | null> {
  let parsed;
  try {
    parsed = parseModelCommand(input.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "error",
      message
    };
  }

  if (parsed === null) {
    return null;
  }

  if (parsed.selection === null) {
    const hasPersistFlag = parsed.persist !== "session";
    const configuredProviders = input.service.listConfiguredProviders();
    if (hasPersistFlag && configuredProviders.length === 0) {
      return {
        kind: "list",
        message: formatFlagsOnlyModelHint(parsed.persist)
      };
    }

    return {
      kind: "list",
      message: formatModelListMessage({
        aliases: resolveMergedModelAliases(input.cwd),
        configuredProviders,
        current: input.currentProvider,
        envOnlyProviders: listEnvOnlyProviderSelections(input.cwd),
        userProviderCount: listUserConfiguredProviderNames().length
      })
    };
  }

  if (input.busy) {
    return {
      kind: "error",
      message: "Cannot switch model while a task is running. Use /stop first."
    };
  }
  if (input.pendingApproval) {
    return {
      kind: "error",
      message: "Cannot switch model while an approval is pending."
    };
  }
  if (input.pendingClarify) {
    return {
      kind: "error",
      message: "Cannot switch model while clarification is pending."
    };
  }

  try {
    const result = await input.service.switchProvider({
      persist: parsed.persist,
      selection: parsed.selection
    });
    return {
      kind: "switched",
      message: formatModelSwitchMessage({
        persist: parsed.persist,
        previous: input.currentProvider,
        resultSelection: result.selection
      }),
      persist: parsed.persist,
      providerConfig: result.providerConfig,
      selection: result.selection,
      tokenBudget: result.tokenBudget
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "error",
      message: `Model switch failed: ${message}`
    };
  }
}

export function currentProviderSelection(config: TuiAppConfig): string {
  return formatProviderSelection(config.provider);
}

export function shouldRestoreProviderSelection(
  current: ResolvedProviderConfig,
  providerSelection: string | null
): providerSelection is string {
  if (providerSelection === null) {
    return false;
  }
  return formatProviderSelection(current) !== providerSelection;
}

export async function restoreSessionProviderSelection(input: {
  currentProvider: ResolvedProviderConfig;
  providerSelection: string;
  service: Pick<TuiRuntimeService, "switchProvider">;
}): Promise<{
  providerConfig: ResolvedProviderConfig;
  selection: string;
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
} | null> {
  if (!shouldRestoreProviderSelection(input.currentProvider, input.providerSelection)) {
    return null;
  }
  const result = await input.service.switchProvider({
    persist: "session",
    selection: input.providerSelection
  });
  return {
    providerConfig: result.providerConfig,
    selection: result.selection,
    tokenBudget: result.tokenBudget
  };
}

export type { ProviderSwitchPersistScope };
