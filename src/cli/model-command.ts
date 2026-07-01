import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Command } from "commander";

import {
  listConfiguredProviders,
  type ConfiguredProviderEntry
} from "../runtime/operations/provider-switch-service.js";
import {
  resolveProviderCatalog,
  useProviderConfig,
  type ProviderConfigScope
} from "../providers/config.js";
import {
  normalizeProviderName,
  resolveDefaultProviderSettings
} from "../providers/provider-registry.js";
import { createApplication, resolveAppConfig } from "../runtime/bootstrap.js";
import type { ModelSelectionView } from "../runtime/operations/model-selection-service.js";
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

export interface ModelCommandFormatOptions {
  json?: boolean;
  sessionId?: string;
}

export function resolveModelCommandWorkspaceFlag(
  commandOptions: { workspace?: boolean },
  command?: Command
): boolean {
  if (commandOptions.workspace === true) {
    return true;
  }
  return command?.parent?.opts()?.workspace === true;
}

export function resolveModelCommandCwd(
  commandOptions: { cwd?: string },
  command?: Command
): string {
  const parent = command?.parent;
  const parentCwd = parent?.opts()?.cwd;
  if (
    typeof parentCwd === "string" &&
    parentCwd.length > 0 &&
    parent?.getOptionValueSource?.("cwd") === "cli"
  ) {
    return parentCwd;
  }
  if (
    commandOptions.cwd !== undefined &&
    commandOptions.cwd.length > 0 &&
    command?.getOptionValueSource?.("cwd") === "cli"
  ) {
    return commandOptions.cwd;
  }
  if (commandOptions.cwd !== undefined && commandOptions.cwd.length > 0) {
    return commandOptions.cwd;
  }
  return process.cwd();
}

export function formatModelStatus(cwd: string, options: ModelCommandFormatOptions = {}): string {
  const handle = createApplication(cwd);
  try {
    const view = handle.service.modelSelectionView(options.sessionId);
    return options.json === true ? JSON.stringify(view, null, 2) : formatModelSelectionView(view);
  } finally {
    handle.close();
  }
}

export function formatModelList(cwd: string, options: ModelCommandFormatOptions = {}): string {
  return formatModelStatus(cwd, options);
}

export function formatModelSelectionView(view: ModelSelectionView): string {
  const lines = [
    `Current model: ${view.current.selection}`,
    `Source: ${view.current.source}${view.current.strict ? " (strict)" : ""}`,
    `Provider: ${view.current.providerName}`,
    `Model: ${view.current.model ?? "-"}`,
    `Base URL: ${view.current.baseUrl ?? "-"}`,
    `Context Window Tokens: ${view.current.contextWindowTokens ?? "-"}`,
    `Credential: ${view.current.credential.credentialStatus} (${view.current.credential.activeCredentialId ?? "-"})`,
    "",
    ...formatConfiguredModelSection(view),
    ...formatEnvironmentOnlyModelSection(view),
    ...formatModelAliasSection(view),
    ...formatFallbackProviderSection(view.fallback),
    ...formatAuxiliaryFallbackSection(view.fallback),
    ...formatFallbackStatusSection(view.fallback),
    ...formatAuxiliarySlotSection(view.auxiliary),
    "",
    "Switch with: talon model set <provider:model>",
    "Session override: talon model set <selection> --session <id>",
    "Clear session override: talon model clear --session <id>"
  ];
  return lines.join("\n");
}

export async function runInteractiveModelWizard(cwd: string, workspace = false): Promise<void> {
  const appConfig = resolveAppConfig(cwd);
  const configured = listConfiguredProviders(appConfig.workspaceRoot);
  const catalog = resolveProviderCatalog(appConfig.workspaceRoot);
  const catalogNames = new Set(catalog.map((entry) => entry.name));
  const configuredNames = new Set(configured.map((entry) => entry.name));

  const rl = createInterface({ input, output });
  try {
    let selectedProvider: ConfiguredProviderEntry | null = null;
    if (configured.length > 0) {
      console.log("Configured providers:");
      configured.forEach((provider, index) => {
        console.log(
          `${index + 1}. ${provider.name} (${provider.displayName}) -> ${provider.model ?? "(default)"} [${provider.configSource}]`
        );
      });
      const answer = await rl.question("Select provider number (or type a new provider name): ");
      const trimmed = answer.trim();
      const index = Number(trimmed);
      if (Number.isInteger(index) && index >= 1 && index <= configured.length) {
        selectedProvider = configured[index - 1] ?? null;
      } else if (trimmed.length > 0) {
        if (!catalogNames.has(trimmed) && !configuredNames.has(trimmed)) {
          throw new Error(`Unknown provider "${trimmed}". Run talon provider setup ${trimmed} first.`);
        }
      } else {
        throw new Error("Provider selection is required.");
      }
    }

    const providerName = selectedProvider?.name ?? (await rl.question("Provider name: ")).trim();
    if (providerName.length === 0) {
      throw new Error("Provider name is required.");
    }

    const builtinProviderName = normalizeProviderName(providerName);
    const defaultModel =
      selectedProvider?.model ??
      (builtinProviderName !== null ? resolveDefaultProviderSettings(builtinProviderName).model : null) ??
      "";
    const modelAnswer = await rl.question(
      defaultModel.length > 0 ? `Model [${defaultModel}]: ` : "Model: "
    );
    const model = modelAnswer.trim().length > 0 ? modelAnswer.trim() : defaultModel;
    const selection = model.length > 0 ? `${providerName}:${model}` : providerName;
    const scope: ProviderConfigScope = workspace ? "workspace" : "user";
    const result = useProviderConfig(selection, { cwd: appConfig.workspaceRoot, scope });
    console.log(
      [
        `Selected ${result.providerName}`,
        `Model: ${result.model ?? "-"}`,
        `Config Path: ${result.configPath}`,
        "Check: talon model status"
      ].join("\n")
    );
  } finally {
    rl.close();
  }
}

export async function setModelSelection(
  selection: string,
  options: { cwd?: string; sessionId?: string; workspace?: boolean } = {}
): Promise<string> {
  if (options.sessionId !== undefined) {
    const handle = createApplication(options.cwd ?? process.cwd());
    try {
      const result = await handle.service.setSessionModelSelection({
        selection,
        sessionId: options.sessionId
      });
      return [
        `Session model selected: ${result.result.selection}`,
        `Session: ${result.session.sessionId}`,
        `Source: ${result.view.current.source}`
      ].join("\n");
    } finally {
      handle.close();
    }
  }

  const appConfig = resolveAppConfig(options.cwd ?? process.cwd());
  const scope: ProviderConfigScope = options.workspace === true ? "workspace" : "user";
  const handle = createApplication(appConfig.workspaceRoot);
  try {
    const result = await handle.service.switchProvider({
      persist: scope,
      selection
    });
    const lines = [
      `Selected ${result.providerConfig.name}`,
      `Model: ${result.providerConfig.model ?? "-"}`,
      `Config Path: ${result.persistedConfigPath ?? result.providerConfig.configPath}`
    ];
    const envNotice = formatEnvProviderOverrideNotice();
    if (envNotice !== null) {
      lines.push(envNotice);
    }
    return lines.join("\n");
  } finally {
    handle.close();
  }
}

export async function clearSessionModelSelection(cwd: string, sessionId: string): Promise<string> {
  const handle = createApplication(cwd);
  try {
    const result = await handle.service.clearSessionModelSelection(sessionId);
    return [
      `Session model override cleared: ${result.session.sessionId}`,
      `Current model: ${result.view.current.selection}`,
      `Source: ${result.view.current.source}`
    ].join("\n");
  } finally {
    handle.close();
  }
}

