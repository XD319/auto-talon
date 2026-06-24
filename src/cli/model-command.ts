import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  listConfiguredProviders,
  formatProviderSelection,
  type ConfiguredProviderEntry
} from "../runtime/operations/provider-switch-service.js";
import {
  resolveMergedFallbackProviders,
  resolveMergedModelAliases,
  resolveProviderCatalog,
  useProviderConfig,
  type ProviderConfigScope
} from "../providers/config.js";
import { listModelAliasEntries } from "../providers/model-aliases.js";
import {
  normalizeProviderName,
  resolveDefaultProviderSettings
} from "../providers/provider-registry.js";
import { resolveAppConfig } from "../runtime/bootstrap.js";
import { resolveRuntimeConfig, writeAuxiliarySlot } from "../runtime/runtime-config.js";
import { formatEnvProviderOverrideNotice } from "../providers/provider-env.js";
import { formatCurrentProvider } from "./formatters.js";

export function formatModelStatus(cwd: string): string {
  const handle = resolveAppConfig(cwd);
  const runtimeConfig = resolveRuntimeConfig(cwd);
  const configured = listConfiguredProviders(handle.workspaceRoot);
  const lines = [
    formatCurrentProvider(handle.provider),
    "",
    "Configured providers:"
  ];
  if (configured.length === 0) {
    lines.push("- (none)");
  } else {
    for (const provider of configured) {
      lines.push(`- ${formatProviderSelection(provider.providerConfig)} [${provider.configSource}]`);
    }
  }

  const fallbackProviders = resolveMergedFallbackProviders(handle.workspaceRoot);
  lines.push("", "Fallback providers:");
  if (fallbackProviders.length === 0) {
    lines.push("- (none)");
  } else {
    for (const [index, selection] of fallbackProviders.entries()) {
      lines.push(`- ${index + 1}. ${selection}`);
    }
  }

  lines.push("", "Auxiliary slots:");
  for (const [slot, value] of Object.entries(runtimeConfig.auxiliary)) {
    lines.push(`- ${slot}: ${value}`);
  }

  const aliases = listModelAliasEntries(resolveMergedModelAliases(handle.workspaceRoot));
  if (aliases.length > 0) {
    lines.push("", "Aliases:");
    for (const entry of aliases) {
      lines.push(`- ${entry.alias} -> ${entry.target}`);
    }
  }

  return lines.join("\n");
}

export function formatModelList(cwd: string): string {
  return formatModelStatus(cwd);
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

export function setModelSelection(
  selection: string,
  options: { cwd?: string; workspace?: boolean } = {}
): string {
  const appConfig = resolveAppConfig(options.cwd ?? process.cwd());
  const scope: ProviderConfigScope = options.workspace === true ? "workspace" : "user";
  const result = useProviderConfig(selection, { cwd: appConfig.workspaceRoot, scope });
  const lines = [
    `Selected ${result.providerName}`,
    `Model: ${result.model ?? "-"}`,
    `Config Path: ${result.configPath}`
  ];
  const envNotice = formatEnvProviderOverrideNotice();
  if (envNotice !== null) {
    lines.push(envNotice);
  }
  return lines.join("\n");
}
