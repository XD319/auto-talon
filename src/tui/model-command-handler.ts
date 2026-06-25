import type { TuiAppConfig, TuiRuntimeService } from "./runtime-api.js";
import type { ResolvedProviderConfig } from "../providers/config.js";
import type { ProviderSwitchPersistScope } from "../runtime/operations/provider-switch-service.js";
import { formatProviderSelection } from "../runtime/operations/provider-switch-service.js";
import {
  formatFlagsOnlyModelHint,
  formatModelClearMessage,
  formatModelListMessage,
  formatModelStatusMessage,
  formatModelSwitchMessage,
  parseModelCommand,
  type ModelCommandResult
} from "./model-command.js";

export async function handleModelCommand(input: {
  activeSessionId: string | null;
  busy: boolean;
  cwd: string;
  currentProvider: ResolvedProviderConfig;
  pendingApproval: boolean;
  pendingClarify: boolean;
  service: Pick<
    TuiRuntimeService,
    "clearSessionModelSelection" | "modelSelectionView" | "switchProvider"
  >;
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

  if (parsed.action === "list" || parsed.action === "status") {
    try {
      const view = input.service.modelSelectionView(input.activeSessionId ?? undefined);
      return {
        kind: parsed.action,
        message:
          parsed.action === "status"
            ? formatModelStatusMessage(view)
            : formatModelListMessage(view)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message: `Model status failed: ${message}`
      };
    }
  }

  const readinessError = validateModelMutationReadiness(input);
  if (readinessError !== null) {
    return {
      kind: "error",
      message: readinessError
    };
  }

  if (parsed.action === "clear") {
    if (input.activeSessionId === null) {
      return {
        kind: "error",
        message: "No active session to clear. Start or resume a session first."
      };
    }
    try {
      const result = await input.service.clearSessionModelSelection(input.activeSessionId);
      const commandResult: ModelCommandResult = {
        kind: "cleared",
        message: formatModelClearMessage({
          currentSelection: result.view.current.selection,
          sessionId: result.session.sessionId
        }),
        persist: "session",
        selection: result.view.current.selection
      };
      if (result.result !== null) {
        commandResult.providerConfig = result.result.providerConfig;
        commandResult.tokenBudget = result.result.tokenBudget;
      }
      return commandResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message: `Model clear failed: ${message}`
      };
    }
  }

  let selection = parsed.selection;
  if (parsed.index !== null) {
    try {
      const view = input.service.modelSelectionView(input.activeSessionId ?? undefined);
      const entry = view.configuredModels[parsed.index - 1];
      if (entry === undefined) {
        return {
          kind: "error",
          message: `Model number ${parsed.index} is not in the configured model list. Run /model to see available models.`
        };
      }
      selection = entry.selection;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "error",
        message: `Model list failed: ${message}`
      };
    }
  }

  if (selection === null || selection.trim().length === 0) {
    return {
      kind: "list",
      message: formatFlagsOnlyModelHint(parsed.persist)
    };
  }

  if (parsed.persist === "session" && input.activeSessionId === null) {
    return {
      kind: "error",
      message: "No active session to switch. Start or resume a session first, or use --global/--workspace."
    };
  }

  try {
    const result = await input.service.switchProvider({
      persist: parsed.persist,
      selection,
      ...(parsed.persist === "session" && input.activeSessionId !== null
        ? { sessionId: input.activeSessionId }
        : {})
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
  sessionId: string;
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
    selection: input.providerSelection,
    sessionId: input.sessionId
  });
  return {
    providerConfig: result.providerConfig,
    selection: result.selection,
    tokenBudget: result.tokenBudget
  };
}

function validateModelMutationReadiness(input: {
  busy: boolean;
  pendingApproval: boolean;
  pendingClarify: boolean;
}): string | null {
  if (input.busy) {
    return "Cannot switch model while a task is running. Use /stop first.";
  }
  if (input.pendingApproval) {
    return "Cannot switch model while an approval is pending.";
  }
  if (input.pendingClarify) {
    return "Cannot switch model while clarification is pending.";
  }
  return null;
}

export type { ProviderSwitchPersistScope };

