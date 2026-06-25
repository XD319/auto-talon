import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { JsonObject, ProviderConfig } from "../types/index.js";
import {
  resolveProviderCredentials,
  selectActiveCredential,
  summarizeProviderCredentials,
  type ProviderCredentialFileEntry,
  type ProviderCredentialSummary,
  type ResolvedProviderCredential
} from "./credential-pool.js";
import {
  externalManifestToCatalogEntry,
  loadExternalProviderManifests,
  type ExternalProviderManifest
} from "./external-provider-manifests.js";
import {
  mergeModelAliases,
  resolveModelAlias,
  type ModelAliasMap
} from "./model-aliases.js";
import { isProviderSwitchable } from "./provider-switchable.js";
import { parseProviderConfigFile } from "./provider-config-schema.js";
import {
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
  type ProviderTransportKind,
  type SupportedProviderName,
  normalizeProviderName,
  parseProviderSelection,
  resolveDefaultProviderSettings,
  requireProviderManifest,
  resolveModelContextWindow,
  resolveProviderModel
} from "./provider-registry.js";

interface ProviderFileEntry extends JsonObject {
  apiKey?: string | null;
  baseUrl?: string | null;
  contextWindowTokens?: number | null;
  credentials?: ProviderCredentialFileEntry[];
  maxRetries?: number;
  model?: string | null;
  streamIdleTimeoutMs?: number;
  timeoutMs?: number;
}

interface CustomProviderFileEntry extends ProviderFileEntry {
  anthropicVersion?: string | null;
  displayName?: string | null;
  providerLabel?: string | null;
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  transport?: Exclude<ProviderTransportKind, "mock">;
}

interface FallbackFileConfig extends JsonObject {
  auxiliary?: Record<string, string[]>;
  main?: string[];
}

interface ProviderConfigFile extends JsonObject {
  currentProvider?: string;
  customProviders?: Record<string, CustomProviderFileEntry>;
  fallback?: FallbackFileConfig;
  fallbackProviders?: string[];
  modelAliases?: Record<string, string>;
  providers?: Record<string, ProviderFileEntry>;
}

export type ProviderListSource = "user" | "workspace" | "workspace-only";

export interface ConfiguredProviderNameEntry {
  name: string;
  source: ProviderListSource;
}

export type ProviderConfigScope = "user" | "workspace";

export interface ProviderConfigWriteOptions {
  apiKey?: string;
  baseUrl?: string;
  cwd?: string;
  maxRetries?: number;
  model?: string;
  contextWindowTokens?: number;
  scope?: ProviderConfigScope;
  streamIdleTimeoutMs?: number;
  timeoutMs?: number;
}

export interface ProviderConfigWriteResult {
  configPath: string;
  model: string | null;
  providerName: string;
  scope: ProviderConfigScope;
}

export interface ResolvedProviderConfig extends ProviderConfig {
  anthropicVersion?: string | null;
  builtinProviderName: SupportedProviderName | null;
  configPath: string;
  configSource: "defaults" | "env" | "file" | "user";
  configured?: boolean;
  credential: ProviderCredentialSummary;
  contextWindowSource:
    | "custom_provider"
    | "explicit_token_budget"
    | "provider_api"
    | "provider_config"
    | "provider_manifest"
    | "provider_model_manifest"
    | null;
  contextWindowTokens: number | null;
  displayName: string;
  family: ProviderTransportKind;
  providerLabel?: string | null;
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  timeoutConfigured?: boolean;
  streamIdleTimeoutConfigured?: boolean;
  transport: ProviderTransportKind;
}

export function resolveProviderConfig(cwd = process.cwd()): ResolvedProviderConfig {
  const providerSelection = process.env.AGENT_PROVIDER;
  return resolveProviderConfigInternal(cwd, {
    includeProviderSelectionEnv: true,
    ...(providerSelection !== undefined ? { providerSelection } : {})
  });
}

export function resolveProviderConfigForProvider(
  cwd: string,
  providerSelection: string
): ResolvedProviderConfig {
  return resolveProviderConfigInternal(cwd, {
    includeProviderSelectionEnv: false,
    providerSelection
  });
}

export function resolveProviderConfigForCredential(
  cwd: string,
  providerSelection: string,
  credentialId: string
): ResolvedProviderConfig {
  return resolveProviderConfigInternal(cwd, {
    credentialId,
    includeProviderSelectionEnv: false,
    providerSelection
  });
}

export function resolveProviderConfigForSwitch(
  cwd: string,
  providerSelection: string
): ResolvedProviderConfig {
  return resolveProviderConfigInternal(cwd, {
    ignoreProviderEnv: true,
    includeProviderSelectionEnv: false,
    providerSelection
  });
}

function resolveProviderConfigInternal(
  cwd: string,
  options: {
    credentialId?: string;
    ignoreProviderEnv?: boolean;
    includeProviderSelectionEnv: boolean;
    providerSelection?: string;
  }
): ResolvedProviderConfig {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfigPath = resolveUserProviderConfigPath();
  const userConfig = loadProviderConfigFile(userConfigPath);
  const workspaceConfig = loadProviderConfigFile(workspaceConfigPath);
  const fileConfig = mergeProviderConfigFiles(userConfig, workspaceConfig);
  const externalCustomProviders = externalManifestsToCustomProviders(
    loadExternalProviderManifests({
      userConfigDir: dirname(userConfigPath),
      workspaceRoot: cwd
    })
  );
  const customProviders = normalizeCustomProviders(
    mergeNamedEntries(externalCustomProviders, fileConfig.customProviders)
  );
  const providerEntries = normalizeProviderEntries(fileConfig.providers, customProviders);
  const providerSelection = resolveConfiguredProviderSelection(
    options.providerSelection ?? workspaceConfig.currentProvider ?? userConfig.currentProvider,
    customProviders
  );
  if (providerSelection.providerName === null) {
    const configSource = resolveProviderConfigSource(
      userConfig,
      workspaceConfig,
      null,
      options.includeProviderSelectionEnv
    );
    return createUnconfiguredProviderConfig(
      resolveConfigPath(configSource, userConfigPath, workspaceConfigPath),
      configSource
    );
  }

  const configuredName = providerSelection.providerName;
  const fileEntry = providerEntries[configuredName];
  const customProvider = customProviders[configuredName];
  const builtinProviderName = normalizeProviderName(configuredName);
  const configSource = resolveProviderConfigSource(
    userConfig,
    workspaceConfig,
    configuredName,
    options.includeProviderSelectionEnv && options.ignoreProviderEnv !== true
  );
  const configPath = resolveConfigPath(configSource, userConfigPath, workspaceConfigPath);

  if (builtinProviderName !== null) {
    const manifest = requireProviderManifest(builtinProviderName);
    const defaults = resolveDefaultProviderSettings(builtinProviderName);
    const model = resolveProviderModel(
      builtinProviderName,
      resolveSwitchableModelValue(
        options.ignoreProviderEnv === true,
        fileEntry?.model,
        providerSelection.modelName,
        defaults.model
      ) ?? null
    );
    const credentials = resolveEntryCredentials({
      credentials: fileEntry?.credentials,
      defaultsApiKey: defaults.apiKey,
      fileApiKey: fileEntry?.apiKey,
      ignoreProviderEnv: options.ignoreProviderEnv === true,
      requestedCredentialId: options.credentialId
    });
    const activeCredential = selectActiveCredential(credentials);

    return {
      apiKey: activeCredential?.apiKey ?? null,
      baseUrl: normalizeNullableString(
        resolveSwitchableEnvString(
          options.ignoreProviderEnv === true,
          process.env.AGENT_PROVIDER_BASE_URL,
          fileEntry?.baseUrl ?? defaults.baseUrl
        )
      ),
      builtinProviderName,
      configPath,
      configSource,
      credential: summarizeProviderCredentials(credentials),
      maxRetries: normalizePositiveNumber(
        resolveSwitchableEnvNumber(
          options.ignoreProviderEnv === true,
          process.env.AGENT_PROVIDER_MAX_RETRIES,
          fileEntry?.maxRetries,
          defaults.maxRetries
        ),
        defaults.maxRetries
      ),
      model,
      name: configuredName,
      configured: true,
      ...resolveBuiltinContextWindow(fileEntry, builtinProviderName, model, manifest),
      displayName: manifest.displayName,
      family: manifest.family,
      supportsStreaming: manifest.supportsStreaming,
      supportsToolCalls: manifest.supportsToolCalls,
      streamIdleTimeoutConfigured:
        (options.ignoreProviderEnv !== true &&
          process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS !== undefined) ||
        fileEntry?.streamIdleTimeoutMs !== undefined,
      streamIdleTimeoutMs: normalizePositiveNumber(
        resolveSwitchableEnvNumber(
          options.ignoreProviderEnv === true,
          process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
          fileEntry?.streamIdleTimeoutMs,
          defaults.streamIdleTimeoutMs
        ),
        defaults.streamIdleTimeoutMs
      ),
      timeoutConfigured:
        (options.ignoreProviderEnv !== true && process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined) ||
        fileEntry?.timeoutMs !== undefined,
      timeoutMs: normalizePositiveNumber(
        resolveSwitchableEnvNumber(
          options.ignoreProviderEnv === true,
          process.env.AGENT_PROVIDER_TIMEOUT_MS,
          fileEntry?.timeoutMs,
          defaults.timeoutMs
        ),
        defaults.timeoutMs
      ),
      transport: manifest.transport
    };
  }

  if (customProvider === undefined) {
    throw new Error(`Unsupported provider "${configuredName}".`);
  }

  const model = resolveCustomProviderModel(
    configuredName,
    resolveSwitchableModelValue(
      options.ignoreProviderEnv === true,
      fileEntry?.model,
      providerSelection.modelName,
      customProvider.model
    ) ?? null
  );
  const credentials = resolveEntryCredentials({
    credentials: fileEntry?.credentials ?? customProvider.credentials,
    defaultsApiKey: customProvider.apiKey,
    fileApiKey: fileEntry?.apiKey,
    ignoreProviderEnv: options.ignoreProviderEnv === true,
    requestedCredentialId: options.credentialId
  });
  const activeCredential = selectActiveCredential(credentials);

  return {
    anthropicVersion: normalizeNullableString(customProvider.anthropicVersion),
    apiKey: activeCredential?.apiKey ?? null,
    baseUrl: normalizeNullableString(
      resolveSwitchableEnvString(
        options.ignoreProviderEnv === true,
        process.env.AGENT_PROVIDER_BASE_URL,
        fileEntry?.baseUrl ?? customProvider.baseUrl
      )
    ),
    builtinProviderName: null,
    configPath,
    configSource,
    credential: summarizeProviderCredentials(credentials),
    maxRetries: normalizePositiveNumber(
      resolveSwitchableEnvNumber(
        options.ignoreProviderEnv === true,
        process.env.AGENT_PROVIDER_MAX_RETRIES,
        fileEntry?.maxRetries,
        normalizePositiveNumber(customProvider.maxRetries, 2)
      ),
      normalizePositiveNumber(customProvider.maxRetries, 2)
    ),
    model,
    name: configuredName,
    configured: true,
    ...resolveCustomContextWindow(fileEntry, customProvider),
    displayName: normalizeNullableString(customProvider.displayName) ?? configuredName,
    family: customProvider.transport,
    providerLabel:
      normalizeNullableString(customProvider.providerLabel) ??
      normalizeNullableString(customProvider.displayName) ??
      configuredName,
    supportsStreaming: customProvider.supportsStreaming ?? true,
    supportsToolCalls: customProvider.supportsToolCalls ?? true,
    streamIdleTimeoutConfigured:
      (options.ignoreProviderEnv !== true &&
        process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS !== undefined) ||
      fileEntry?.streamIdleTimeoutMs !== undefined ||
      customProvider.streamIdleTimeoutMs !== undefined,
    streamIdleTimeoutMs: normalizePositiveNumber(
      resolveSwitchableEnvNumber(
        options.ignoreProviderEnv === true,
        process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
        fileEntry?.streamIdleTimeoutMs ?? customProvider.streamIdleTimeoutMs,
        normalizePositiveNumber(customProvider.streamIdleTimeoutMs, 300_000)
      ),
      normalizePositiveNumber(customProvider.streamIdleTimeoutMs, 300_000)
    ),
    timeoutConfigured:
      (options.ignoreProviderEnv !== true && process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined) ||
      fileEntry?.timeoutMs !== undefined ||
      customProvider.timeoutMs !== undefined,
    timeoutMs: normalizePositiveNumber(
      resolveSwitchableEnvNumber(
        options.ignoreProviderEnv === true,
        process.env.AGENT_PROVIDER_TIMEOUT_MS,
        fileEntry?.timeoutMs ?? customProvider.timeoutMs,
        normalizePositiveNumber(customProvider.timeoutMs, 120_000)
      ),
      normalizePositiveNumber(customProvider.timeoutMs, 120_000)
    ),
    transport: customProvider.transport
  };
}

export function resolveProviderCredentialConfigs(
  cwd: string,
  providerSelection: string
): ResolvedProviderConfig[] {
  const base = resolveProviderConfigForProvider(cwd, providerSelection);
  const credentialIds = listAvailableCredentialIds(base);
  if (credentialIds.length <= 1) {
    return [base];
  }
  return credentialIds.map((credentialId) =>
    resolveProviderConfigForCredential(cwd, providerSelection, credentialId)
  );
}

export function resolveMergedModelAliases(cwd = process.cwd()): ModelAliasMap {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfigPath = resolveUserProviderConfigPath();
  return mergeModelAliases(
    loadProviderConfigFile(userConfigPath).modelAliases,
    loadProviderConfigFile(workspaceConfigPath).modelAliases
  );
}

export function resolveProviderSelectionWithAliases(
  selection: string,
  cwd = process.cwd()
): string {
  const aliases = resolveMergedModelAliases(cwd);
  return resolveModelAlias(selection, aliases);
}

function collectConfiguredProviderNamesFromConfig(config: ProviderConfigFile): Set<string> {
  const names = new Set<string>();

  for (const name of Object.keys(normalizeCustomProviders(config.customProviders))) {
    names.add(name);
  }

  for (const [rawName, entry] of Object.entries(config.providers ?? {})) {
    const normalized = normalizeProviderName(rawName);
    const providerName = normalized ?? rawName;
    if (normalized === "mock" || normalized === "ollama") {
      names.add(providerName);
      continue;
    }
    if (hasConfiguredCredential(entry)) {
      names.add(providerName);
    }
  }

  return names;
}

export function listUserConfiguredProviderNames(): string[] {
  const userConfig = loadProviderConfigFile(resolveUserProviderConfigPath());
  return [...collectConfiguredProviderNamesFromConfig(userConfig)].sort((left, right) =>
    left.localeCompare(right)
  );
}

function hasWorkspaceProviderOverride(
  name: string,
  userConfig: ProviderConfigFile,
  workspaceConfig: ProviderConfigFile
): boolean {
  const workspaceCustom = workspaceConfig.customProviders?.[name];
  const workspaceBuiltin = workspaceConfig.providers?.[name];
  if (workspaceCustom === undefined && workspaceBuiltin === undefined) {
    return false;
  }

  const userCustom = normalizeCustomProviders(userConfig.customProviders)[name] ?? userConfig.customProviders?.[name];
  const userBuiltin = userConfig.providers?.[name];
  const userEntry = userCustom ?? userBuiltin;
  const workspaceEntry = workspaceCustom ?? workspaceBuiltin;
  if (userEntry === undefined || workspaceEntry === undefined) {
    return workspaceEntry !== undefined;
  }

  const overrideFields: Array<keyof ProviderFileEntry> = [
    "apiKey",
    "baseUrl",
    "credentials",
    "model",
    "contextWindowTokens",
    "maxRetries",
    "streamIdleTimeoutMs",
    "timeoutMs"
  ];
  return overrideFields.some((field) => {
    const workspaceValue = workspaceEntry[field];
    if (workspaceValue === undefined) {
      return false;
    }
    return workspaceValue !== userEntry[field];
  });
}

function hasWorkspaceProviderEntry(name: string, workspaceConfig: ProviderConfigFile): boolean {
  return (
    workspaceConfig.customProviders?.[name] !== undefined ||
    workspaceConfig.providers?.[name] !== undefined
  );
}

function resolveProviderListSource(
  name: string,
  userConfig: ProviderConfigFile,
  workspaceConfig: ProviderConfigFile,
  userNames: Set<string>,
  workspaceNames: Set<string>
): ProviderListSource {
  const inUser = userNames.has(name);
  const inWorkspace = workspaceNames.has(name) || hasWorkspaceProviderEntry(name, workspaceConfig);
  if (!inUser && inWorkspace) {
    return "workspace-only";
  }
  if (inUser && inWorkspace && hasWorkspaceProviderOverride(name, userConfig, workspaceConfig)) {
    return "workspace";
  }
  return "user";
}

export function listConfiguredProviderEntries(cwd = process.cwd()): ConfiguredProviderNameEntry[] {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfig = loadProviderConfigFile(resolveUserProviderConfigPath());
  const workspaceConfig = loadProviderConfigFile(workspaceConfigPath);
  const userNames = collectConfiguredProviderNamesFromConfig(userConfig);
  const workspaceNames = collectConfiguredProviderNamesFromConfig(workspaceConfig);
  const allNames = new Set([...userNames, ...workspaceNames]);

  return [...allNames]
    .map((name) => ({
      name,
      source: resolveProviderListSource(name, userConfig, workspaceConfig, userNames, workspaceNames)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function listConfiguredProviderNames(cwd = process.cwd()): string[] {
  return listConfiguredProviderEntries(cwd).map((entry) => entry.name);
}

export function listEnvOnlyProviderSelections(cwd = process.cwd()): Array<{ selection: string }> {
  const envProvider = process.env.AGENT_PROVIDER?.trim();
  if (envProvider === undefined || envProvider.length === 0) {
    return [];
  }

  const parsed = parseProviderSelection(envProvider);
  const providerName = parsed.providerName;
  if (providerName === null) {
    return [];
  }

  const configuredNames = new Set(listConfiguredProviderEntries(cwd).map((entry) => entry.name));
  if (configuredNames.has(providerName)) {
    return [];
  }

  const envModel = process.env.AGENT_PROVIDER_MODEL?.trim();
  const selection =
    envModel !== undefined && envModel.length > 0 ? `${providerName}:${envModel}` : providerName;
  return [{ selection }];
}

export function resolveProviderCatalog(cwd = process.cwd()): ProviderCatalogEntry[] {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfigPath = resolveUserProviderConfigPath();
  const fileConfig = mergeProviderConfigFiles(
    loadProviderConfigFile(userConfigPath),
    loadProviderConfigFile(workspaceConfigPath)
  );
  const externalManifests = loadExternalProviderManifests({
    userConfigDir: dirname(userConfigPath),
    workspaceRoot: cwd
  });
  const customProviders = normalizeCustomProviders(fileConfig.customProviders);
  const catalog = new Map<string, ProviderCatalogEntry>();
  for (const entry of PROVIDER_CATALOG) {
    catalog.set(entry.name, entry);
  }
  for (const manifest of externalManifests) {
    catalog.set(manifest.name, externalManifestToCatalogEntry(manifest));
  }
  for (const [name, provider] of Object.entries(customProviders)) {
    const existing = catalog.get(name);
    catalog.set(name, {
      aliases: existing?.aliases ?? [],
      contextWindowTokens: normalizeOptionalPositiveInteger(provider.contextWindowTokens) ?? null,
      displayName: normalizeNullableString(provider.displayName) ?? name,
      family: provider.transport,
      name,
      supportsConfiguration: true,
      supportsStreaming: provider.supportsStreaming ?? true,
      supportsToolCalls: provider.supportsToolCalls ?? true,
      transport: provider.transport
    });
  }

  return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function setupProviderConfig(
  providerSelection: string,
  options: ProviderConfigWriteOptions = {}
): ProviderConfigWriteResult {
  return writeProviderConfig(providerSelection, options, {
    writeSetupEntry: true
  });
}

export function useProviderConfig(
  providerSelection: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): ProviderConfigWriteResult {
  const cwd = options.cwd ?? process.cwd();
  const resolvedSelection = resolveProviderSelectionWithAliases(providerSelection, cwd);
  const providerConfig = resolveProviderConfigForSwitch(cwd, resolvedSelection);
  if (!isProviderSwitchable(providerConfig)) {
    throw new Error(
      `Provider "${providerConfig.name}" is not configured. Run talon provider setup ${providerConfig.name} first.`
    );
  }
  return writeProviderConfig(resolvedSelection, options, {
    writeSetupEntry: false
  });
}

export interface AliasConfigWriteResult {
  alias: string;
  configPath: string;
  scope: ProviderConfigScope;
  target: string;
}

export function addModelAliasConfig(
  alias: string,
  target: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): AliasConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const normalizedAlias = alias.trim().toLowerCase();
  const normalizedTarget = target.trim();
  if (normalizedAlias.length === 0) {
    throw new Error("Alias is required.");
  }
  if (normalizedTarget.length === 0) {
    throw new Error("Alias target is required.");
  }
  const cwd = options.cwd ?? process.cwd();
  const resolvedTarget = resolveProviderSelectionWithAliases(normalizedTarget, cwd);
  try {
    const targetConfig = resolveProviderConfigForProvider(cwd, resolvedTarget);
    if (!isProviderSwitchable(targetConfig)) {
      throw new Error(`Alias target "${normalizedTarget}" is not a configured provider.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Alias target "${normalizedTarget}" is invalid: ${message}`);
  }
  const mergedAliases = mergeModelAliases(
    loadProviderConfigFile(resolveUserProviderConfigPath()).modelAliases,
    loadProviderConfigFile(join(resolve(cwd), ".auto-talon", "provider.config.json")).modelAliases
  );
  const probeAliases = { ...mergedAliases, [normalizedAlias]: normalizedTarget };
  resolveModelAlias(normalizedAlias, probeAliases);
  const nextConfig: ProviderConfigFile = {
    ...fileConfig,
    modelAliases: {
      ...(fileConfig.modelAliases ?? {}),
      [normalizedAlias]: normalizedTarget
    }
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return {
    alias: normalizedAlias,
    configPath,
    scope,
    target: normalizedTarget
  };
}

export function removeModelAliasConfig(
  alias: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): AliasConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const normalizedAlias = alias.trim().toLowerCase();
  const target = fileConfig.modelAliases?.[normalizedAlias];
  if (target === undefined) {
    throw new Error(`Alias "${normalizedAlias}" is not configured.`);
  }
  const nextAliases = { ...(fileConfig.modelAliases ?? {}) };
  delete nextAliases[normalizedAlias];
  const nextConfig = omitProviderConfigKeys(
    {
      ...fileConfig,
      ...(Object.keys(nextAliases).length > 0 ? { modelAliases: nextAliases } : {})
    },
    Object.keys(nextAliases).length > 0 ? [] : ["modelAliases"]
  );
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return {
    alias: normalizedAlias,
    configPath,
    scope,
    target
  };
}

export interface CustomProviderSetupOptions extends Pick<ProviderConfigWriteOptions, "cwd" | "scope"> {
  anthropicVersion?: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  displayName?: string;
  maxRetries?: number;
  model?: string;
  streamIdleTimeoutMs?: number;
  timeoutMs?: number;
  transport: Exclude<ProviderTransportKind, "mock">;
}

export function setupCustomProviderConfig(
  name: string,
  options: CustomProviderSetupOptions
): ProviderConfigWriteResult {
  const normalizedName = name.trim();
  if (normalizedName.length === 0) {
    throw new Error("Custom provider name is required.");
  }
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const existingEntry = fileConfig.customProviders?.[normalizedName] ?? {};
  const nextEntry: CustomProviderFileEntry = {
    ...existingEntry,
    transport: options.transport,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.displayName !== undefined ? { displayName: options.displayName } : {}),
    ...(options.contextWindowTokens !== undefined
      ? { contextWindowTokens: options.contextWindowTokens }
      : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
    ...(options.anthropicVersion !== undefined ? { anthropicVersion: options.anthropicVersion } : {})
  };
  const nextConfig: ProviderConfigFile = {
    version: 1,
    ...fileConfig,
    currentProvider: normalizedName,
    customProviders: {
      ...(fileConfig.customProviders ?? {}),
      [normalizedName]: nextEntry
    }
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return {
    configPath,
    model: normalizeNullableString(options.model) ?? normalizeNullableString(existingEntry.model),
    providerName: normalizedName,
    scope
  };
}

export function removeCustomProviderConfig(
  name: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): ProviderConfigWriteResult {
  const normalizedName = name.trim();
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  if (fileConfig.customProviders?.[normalizedName] === undefined) {
    throw new Error(`Custom provider "${normalizedName}" is not configured.`);
  }
  const nextCustomProviders = { ...(fileConfig.customProviders ?? {}) };
  delete nextCustomProviders[normalizedName];
  let nextConfig: ProviderConfigFile = {
    ...fileConfig,
    ...(Object.keys(nextCustomProviders).length > 0 ? { customProviders: nextCustomProviders } : {})
  };
  nextConfig = omitProviderConfigKeys(
    nextConfig,
    Object.keys(nextCustomProviders).length > 0 ? [] : ["customProviders"]
  );
  if (fileConfig.currentProvider === normalizedName) {
    nextConfig = omitProviderConfigKeys(nextConfig, ["currentProvider"]);
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return {
    configPath,
    model: null,
    providerName: normalizedName,
    scope
  };
}

export interface ProviderCredentialConfigWriteResult {
  configPath: string;
  credentials: Array<{
    apiKeyEnv: string | null;
    cooldownUntil: string | null;
    disabled: boolean;
    id: string;
    lastFailure: string | null;
    priority: number;
  }>;
  providerName: string;
  scope: ProviderConfigScope;
}

export function listProviderCredentialConfig(
  providerSelection: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): ProviderCredentialConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const providerName = resolveProviderNameForCredentialWrite(providerSelection, fileConfig, options.cwd);
  return {
    configPath,
    credentials: serializeCredentialEntries(fileConfig.providers?.[providerName]?.credentials ?? []),
    providerName,
    scope
  };
}

export function addProviderCredentialEnvConfig(
  providerSelection: string,
  input: { envName: string; id?: string; priority?: number } & Pick<ProviderConfigWriteOptions, "cwd" | "scope">
): ProviderCredentialConfigWriteResult {
  const scope = input.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, input.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const providerName = resolveProviderNameForCredentialWrite(providerSelection, fileConfig, input.cwd);
  const id = normalizeNullableString(input.id) ?? input.envName.trim();
  const envName = input.envName.trim();
  if (envName.length === 0) {
    throw new Error("Credential env name is required.");
  }
  const providers = { ...(fileConfig.providers ?? {}) };
  const entry = { ...(providers[providerName] ?? {}) };
  const credentials = [...(entry.credentials ?? [])];
  if (credentials.some((credential) => credential.id === id)) {
    throw new Error(`Credential "${id}" is already configured for provider "${providerName}".`);
  }
  credentials.push({
    apiKeyEnv: envName,
    disabled: false,
    id,
    ...(input.priority !== undefined ? { priority: input.priority } : {})
  });
  providers[providerName] = { ...entry, credentials };
  const nextConfig: ProviderConfigFile = { version: 1, ...fileConfig, providers };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { configPath, credentials: serializeCredentialEntries(credentials), providerName, scope };
}

export function setProviderCredentialEnabledConfig(
  providerSelection: string,
  credentialId: string,
  enabled: boolean,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): ProviderCredentialConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const providerName = resolveProviderNameForCredentialWrite(providerSelection, fileConfig, options.cwd);
  const providers = { ...(fileConfig.providers ?? {}) };
  const entry = { ...(providers[providerName] ?? {}) };
  const credentials = [...(entry.credentials ?? [])];
  const index = credentials.findIndex((credential) => credential.id === credentialId);
  if (index < 0) {
    throw new Error(`Credential "${credentialId}" is not configured for provider "${providerName}".`);
  }
  credentials[index] = { ...credentials[index]!, disabled: !enabled };
  providers[providerName] = { ...entry, credentials };
  const nextConfig: ProviderConfigFile = { version: 1, ...fileConfig, providers };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { configPath, credentials: serializeCredentialEntries(credentials), providerName, scope };
}

export function removeProviderCredentialConfig(
  providerSelection: string,
  credentialId: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> = {}
): ProviderCredentialConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const providerName = resolveProviderNameForCredentialWrite(providerSelection, fileConfig, options.cwd);
  const providers = { ...(fileConfig.providers ?? {}) };
  const entry = { ...(providers[providerName] ?? {}) };
  const credentials = [...(entry.credentials ?? [])];
  const nextCredentials = credentials.filter((credential) => credential.id !== credentialId);
  if (nextCredentials.length === credentials.length) {
    throw new Error(`Credential "${credentialId}" is not configured for provider "${providerName}".`);
  }
  providers[providerName] = { ...entry, credentials: nextCredentials };
  const nextConfig: ProviderConfigFile = { version: 1, ...fileConfig, providers };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { configPath, credentials: serializeCredentialEntries(nextCredentials), providerName, scope };
}
export interface FallbackConfigWriteResult {
  configPath: string;
  fallbackProviders: string[];
  scope: ProviderConfigScope;
}

export interface ResolvedFallbackConfig extends JsonObject {
  auxiliary: Record<string, string[]>;
  main: string[];
}

export function resolveMergedFallbackConfig(cwd = process.cwd()): ResolvedFallbackConfig {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfig = loadProviderConfigFile(resolveUserProviderConfigPath());
  const workspaceConfig = loadProviderConfigFile(workspaceConfigPath);
  return mergeFallbackConfigs(userConfig, workspaceConfig);
}

export function resolveMergedFallbackProviders(cwd = process.cwd()): string[] {
  return resolveMergedFallbackConfig(cwd).main;
}

export function resolveMergedFallbackProvidersForSlot(
  cwd = process.cwd(),
  slot: string | null = null
): string[] {
  const config = resolveMergedFallbackConfig(cwd);
  if (slot === null || slot === "main") {
    return config.main;
  }
  return config.auxiliary[slot] ?? config.main;
}

export function addFallbackProviderConfig(
  selection: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> & { slot?: string } = {}
): FallbackConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const normalizedSelection = selection.trim();
  if (normalizedSelection.length === 0) {
    throw new Error("Fallback provider selection is required.");
  }
  const cwd = options.cwd ?? process.cwd();
  const resolvedSelection = resolveProviderSelectionWithAliases(normalizedSelection, cwd);
  const fallbackConfig = resolveProviderConfigForProvider(cwd, resolvedSelection);
  if (!isProviderSwitchable(fallbackConfig)) {
    throw new Error(
      `Fallback provider "${normalizedSelection}" is not configured. Run talon provider setup first.`
    );
  }
  const slot = normalizeNullableString(options.slot);
  const existing = slot === null
    ? fileConfig.fallbackProviders ?? fileConfig.fallback?.main ?? []
    : fileConfig.fallback?.auxiliary?.[slot] ?? [];
  if (existing.includes(normalizedSelection)) {
    throw new Error(`Fallback provider "${normalizedSelection}" is already configured.`);
  }
  const fallbackProviders = [...existing, normalizedSelection];
  const nextFallback: FallbackFileConfig = {
    ...(fileConfig.fallback ?? {}),
    ...(slot === null
      ? { main: fallbackProviders }
      : {
          auxiliary: {
            ...(fileConfig.fallback?.auxiliary ?? {}),
            [slot]: fallbackProviders
          }
        })
  };
  const nextConfig: ProviderConfigFile = {
    ...fileConfig,
    ...(slot === null ? { fallbackProviders } : {}),
    fallback: nextFallback
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { configPath, fallbackProviders, scope };
}

export function removeFallbackProviderConfig(
  selection: string,
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> & { slot?: string } = {}
): FallbackConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const normalizedSelection = selection.trim();
  const slot = normalizeNullableString(options.slot);
  const existing = slot === null
    ? fileConfig.fallbackProviders ?? fileConfig.fallback?.main ?? []
    : fileConfig.fallback?.auxiliary?.[slot] ?? [];
  const fallbackProviders = existing.filter((entry) => entry !== normalizedSelection);
  if (fallbackProviders.length === existing.length) {
    throw new Error(`Fallback provider "${normalizedSelection}" is not configured.`);
  }
  const nextFallback: FallbackFileConfig = {
    ...(fileConfig.fallback ?? {}),
    ...(slot === null
      ? fallbackProviders.length > 0 ? { main: fallbackProviders } : {}
      : {
          auxiliary: {
            ...(fileConfig.fallback?.auxiliary ?? {}),
            ...(fallbackProviders.length > 0 ? { [slot]: fallbackProviders } : {})
          }
        })
  };
  if (slot !== null && fallbackProviders.length === 0) {
    delete nextFallback.auxiliary?.[slot];
  }
  const nextConfig = omitProviderConfigKeys(
    {
      ...fileConfig,
      ...(slot === null && fallbackProviders.length > 0 ? { fallbackProviders } : {}),
      fallback: nextFallback
    },
    slot === null && fallbackProviders.length === 0 ? ["fallbackProviders"] : []
  );
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { configPath, fallbackProviders, scope };
}

export function clearFallbackProviderConfig(
  options: Pick<ProviderConfigWriteOptions, "cwd" | "scope"> & { slot?: string } = {}
): FallbackConfigWriteResult {
  const scope = options.scope ?? "user";
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const slot = normalizeNullableString(options.slot);
  let nextConfig: ProviderConfigFile;
  if (slot === null) {
    const nextFallback = { ...(fileConfig.fallback ?? {}) };
    delete nextFallback.main;
    nextConfig = omitProviderConfigKeys({ ...fileConfig, fallback: nextFallback }, ["fallbackProviders"]);
  } else {
    const nextFallback = { ...(fileConfig.fallback ?? {}) };
    const auxiliary = { ...(nextFallback.auxiliary ?? {}) };
    delete auxiliary[slot];
    nextFallback.auxiliary = auxiliary;
    nextConfig = { ...fileConfig, fallback: nextFallback };
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  return { configPath, fallbackProviders: [], scope };
}

export function promoteProviderConfig(config: ResolvedProviderConfig): ProviderConfigWriteResult {
  if (config.configured === false) {
    throw new Error("No configured provider is available to promote.");
  }

  const configPath = resolveProviderConfigPath("user");
  const fileConfig = loadProviderConfigFile(configPath);
  const nextConfig: ProviderConfigFile = {
    version: 1,
    ...fileConfig,
    currentProvider: config.name,
    providers: {
      ...(fileConfig.providers ?? {}),
      [config.name]: createPromotedProviderEntry(
        fileConfig.providers?.[config.name],
        config
      )
    }
  };

  if (config.builtinProviderName === null) {
    nextConfig.customProviders = {
      ...(fileConfig.customProviders ?? {}),
      [config.name]: createPromotedCustomProviderEntry(
        fileConfig.customProviders?.[config.name],
        config
      )
    };
  }

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    configPath,
    model: config.model,
    providerName: config.name,
    scope: "user"
  };
}

export function resolveProviderConfigPath(
  scope: ProviderConfigScope,
  cwd = process.cwd()
): string {
  return scope === "user"
    ? resolveUserProviderConfigPath()
    : join(resolve(cwd), ".auto-talon", "provider.config.json");
}

export function maskSecret(secret: string | null): string {
  if (secret === null || secret.length === 0) {
    return "missing";
  }

  if (secret.length <= 6) {
    return "***";
  }

  return `${secret.slice(0, 3)}***${secret.slice(-2)}`;
}

export function hasLegacyShortRemoteTimeout(config: ResolvedProviderConfig): boolean {
  return (
    config.timeoutConfigured === true &&
    config.timeoutMs <= 30_000 &&
    config.transport !== "mock" &&
    config.builtinProviderName !== "ollama"
  );
}

function omitProviderConfigKeys(
  config: ProviderConfigFile,
  keys: Array<keyof ProviderConfigFile>
): ProviderConfigFile {
  const nextConfig = { ...config };
  for (const key of keys) {
    delete nextConfig[key];
  }
  return nextConfig;
}

function loadProviderConfigFile(configPath: string): ProviderConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf8").trim();
  if (content.length === 0) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return parseProviderConfigFile(parsed, configPath) as ProviderConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse provider config ${configPath}: ${message}`);
  }
}

export function resolveUserProviderConfigPath(): string {
  const configDir = process.env.AGENT_USER_CONFIG_DIR?.trim();
  const userConfigDir =
    configDir && configDir.length > 0 ? configDir : join(homedir(), ".auto-talon");
  return join(resolve(userConfigDir), "provider.config.json");
}

function writeProviderConfig(
  providerSelection: string,
  options: ProviderConfigWriteOptions,
  behavior: { writeSetupEntry: boolean }
): ProviderConfigWriteResult {
  const scope = options.scope ?? "user";
  const cwd = options.cwd ?? process.cwd();
  const configPath = resolveProviderConfigPath(scope, cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const aliasedSelection = resolveProviderSelectionWithAliases(providerSelection, cwd);
  const selection = resolveConfiguredProviderSelection(
    aliasedSelection,
    normalizeCustomProviders(fileConfig.customProviders)
  );
  if (selection.providerName === null) {
    throw new Error("Provider name is required.");
  }

  const providerName = selection.providerName;
  const providers = {
    ...(fileConfig.providers ?? {})
  };
  const existingEntry = providers[providerName] ?? {};
  const model = normalizeNullableString(options.model) ?? selection.modelName;
  const nextEntry = {
    ...existingEntry,
    ...(behavior.writeSetupEntry && options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(behavior.writeSetupEntry && options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(behavior.writeSetupEntry && options.contextWindowTokens !== undefined
      ? { contextWindowTokens: options.contextWindowTokens }
      : {}),
    ...(behavior.writeSetupEntry && options.maxRetries !== undefined
      ? { maxRetries: options.maxRetries }
      : {}),
    ...(model !== null ? { model } : {}),
    ...(behavior.writeSetupEntry && options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
    ,
    ...(behavior.writeSetupEntry && options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {})
  };

  const nextConfig: ProviderConfigFile = {
    version: 1,
    ...fileConfig,
    currentProvider: providerName,
    providers: {
      ...providers,
      ...(Object.keys(nextEntry).length > 0 || behavior.writeSetupEntry
        ? { [providerName]: nextEntry }
        : {})
    }
  };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    configPath,
    model,
    providerName,
    scope
  };
}

function createPromotedProviderEntry(
  existingEntry: ProviderFileEntry | undefined,
  config: ResolvedProviderConfig
): ProviderFileEntry {
  return {
    ...(existingEntry ?? {}),
    ...(config.apiKey !== null ? { apiKey: config.apiKey } : {}),
    ...(config.baseUrl !== null ? { baseUrl: config.baseUrl } : {}),
    ...(config.contextWindowTokens !== null ? { contextWindowTokens: config.contextWindowTokens } : {}),
    maxRetries: config.maxRetries,
    ...(config.model !== null ? { model: config.model } : {}),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    timeoutMs: config.timeoutMs
  };
}

function createPromotedCustomProviderEntry(
  existingEntry: CustomProviderFileEntry | undefined,
  config: ResolvedProviderConfig
): CustomProviderFileEntry {
  if (config.transport !== "anthropic-compatible" && config.transport !== "openai-compatible") {
    throw new Error(`Provider "${config.name}" cannot be promoted as a custom provider.`);
  }

  return {
    ...(existingEntry ?? {}),
    ...(config.anthropicVersion !== undefined && config.anthropicVersion !== null
      ? { anthropicVersion: config.anthropicVersion }
      : {}),
    displayName: config.displayName,
    ...(config.contextWindowTokens !== null ? { contextWindowTokens: config.contextWindowTokens } : {}),
    ...(config.providerLabel !== undefined && config.providerLabel !== null
      ? { providerLabel: config.providerLabel }
      : {}),
    transport: config.transport
  };
}

function mergeProviderConfigFiles(
  userConfig: ProviderConfigFile,
  workspaceConfig: ProviderConfigFile
): ProviderConfigFile {
  const customProviders = mergeNamedEntries(
    userConfig.customProviders,
    workspaceConfig.customProviders
  );
  const providers = mergeNamedEntries(userConfig.providers, workspaceConfig.providers);
  const modelAliases = mergeModelAliases(userConfig.modelAliases, workspaceConfig.modelAliases);
  const fallback = mergeFallbackConfigs(userConfig, workspaceConfig);

  return {
    ...userConfig,
    ...workspaceConfig,
    ...(workspaceConfig.currentProvider !== undefined
      ? { currentProvider: workspaceConfig.currentProvider }
      : userConfig.currentProvider !== undefined
        ? { currentProvider: userConfig.currentProvider }
        : {}),
    ...(customProviders !== undefined ? { customProviders } : {}),
    ...(Object.keys(modelAliases).length > 0 ? { modelAliases } : {}),
    ...(providers !== undefined ? { providers } : {}),
    ...(fallback.main.length > 0 ? { fallbackProviders: fallback.main } : {}),
    ...(fallback.main.length > 0 || Object.keys(fallback.auxiliary).length > 0 ? { fallback } : {})
  };
}

function mergeFallbackConfigs(
  userConfig: ProviderConfigFile,
  workspaceConfig: ProviderConfigFile
): ResolvedFallbackConfig {
  const main = mergeFallbackProviderLists(
    [...(userConfig.fallback?.main ?? []), ...(userConfig.fallbackProviders ?? [])],
    [...(workspaceConfig.fallback?.main ?? []), ...(workspaceConfig.fallbackProviders ?? [])]
  );
  const auxiliary: Record<string, string[]> = {};
  const slots = new Set([
    ...Object.keys(userConfig.fallback?.auxiliary ?? {}),
    ...Object.keys(workspaceConfig.fallback?.auxiliary ?? {})
  ]);
  for (const slot of slots) {
    const merged = mergeFallbackProviderLists(
      userConfig.fallback?.auxiliary?.[slot],
      workspaceConfig.fallback?.auxiliary?.[slot]
    );
    if (merged.length > 0) {
      auxiliary[slot] = merged;
    }
  }
  return { auxiliary, main };
}

function mergeFallbackProviderLists(
  userList: string[] | undefined,
  workspaceList: string[] | undefined
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...(workspaceList ?? []), ...(userList ?? [])]) {
    const normalized = entry.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function mergeNamedEntries<TEntry extends JsonObject>(
  base: Record<string, TEntry> | undefined,
  override: Record<string, TEntry> | undefined
): Record<string, TEntry> | undefined {
  if (base === undefined && override === undefined) {
    return undefined;
  }

  const merged: Record<string, TEntry> = {};
  for (const [name, entry] of Object.entries(base ?? {})) {
    merged[name] = { ...entry };
  }
  for (const [name, entry] of Object.entries(override ?? {})) {
    merged[name] = {
      ...(merged[name] ?? {}),
      ...entry
    } as TEntry;
  }
  return merged;
}

function resolveProviderConfigSource(
  userConfig: ProviderConfigFile,
  workspaceConfig: ProviderConfigFile,
  providerName: string | null,
  includeProviderSelectionEnv: boolean
): ResolvedProviderConfig["configSource"] {
  if (hasProviderEnvConfig(includeProviderSelectionEnv)) {
    return "env";
  }

  if (hasProviderContribution(workspaceConfig, providerName)) {
    return "file";
  }

  if (hasProviderContribution(userConfig, providerName)) {
    return "user";
  }

  return "defaults";
}

function hasProviderEnvConfig(includeProviderSelectionEnv: boolean): boolean {
  return (
    (includeProviderSelectionEnv && process.env.AGENT_PROVIDER !== undefined) ||
    process.env.AGENT_PROVIDER_MODEL !== undefined ||
    process.env.AGENT_PROVIDER_BASE_URL !== undefined ||
    process.env.AGENT_PROVIDER_API_KEY !== undefined ||
    process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS !== undefined ||
    process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined ||
    process.env.AGENT_PROVIDER_MAX_RETRIES !== undefined
  );
}

function hasProviderContribution(config: ProviderConfigFile, providerName: string | null): boolean {
  if (config.currentProvider !== undefined) {
    return true;
  }

  if (providerName === null) {
    return false;
  }

  return (
    hasProviderEntry(config.providers, providerName) ||
    config.customProviders?.[providerName] !== undefined
  );
}

function hasProviderEntry(
  providers: Record<string, ProviderFileEntry> | undefined,
  providerName: string
): boolean {
  if (providers?.[providerName] !== undefined) {
    return true;
  }

  return Object.keys(providers ?? {}).some((name) => normalizeProviderName(name) === providerName);
}

function resolveConfigPath(
  configSource: ResolvedProviderConfig["configSource"],
  userConfigPath: string,
  workspaceConfigPath: string
): string {
  return configSource === "user" ? userConfigPath : workspaceConfigPath;
}

function createUnconfiguredProviderConfig(
  configPath: string,
  configSource: ResolvedProviderConfig["configSource"]
): ResolvedProviderConfig {
  return {
    apiKey: null,
    baseUrl: null,
    builtinProviderName: null,
    configPath,
    configSource,
    configured: false,
    contextWindowSource: null,
    contextWindowTokens: null,
    credential: {
      activeCredentialId: null,
      availableCredentialIds: [],
      credentialCount: 0,
      credentialSource: null,
      credentialStatus: "missing"
    },
    displayName: "Provider not configured",
    family: "mock",
    maxRetries: 0,
    model: null,
    name: "unconfigured",
    streamIdleTimeoutConfigured: false,
    streamIdleTimeoutMs: 5_000,
    supportsStreaming: false,
    supportsToolCalls: false,
    timeoutConfigured: false,
    timeoutMs: 5_000,
    transport: "mock"
  };
}

function resolveBuiltinContextWindow(
  fileEntry: ProviderFileEntry | undefined,
  providerName: SupportedProviderName,
  model: string | null,
  manifest: { contextWindowTokens: number | null }
): Pick<ResolvedProviderConfig, "contextWindowSource" | "contextWindowTokens"> {
  const configured = normalizeOptionalPositiveInteger(fileEntry?.contextWindowTokens);
  if (configured !== null) {
    return {
      contextWindowSource: "provider_config",
      contextWindowTokens: configured
    };
  }
  const resolved = resolveModelContextWindow(providerName, model, manifest.contextWindowTokens);
  return {
    contextWindowSource: resolved.source,
    contextWindowTokens: resolved.contextWindowTokens
  };
}

function resolveCustomContextWindow(
  fileEntry: ProviderFileEntry | undefined,
  customProvider: CustomProviderFileEntry
): Pick<ResolvedProviderConfig, "contextWindowSource" | "contextWindowTokens"> {
  const configured = normalizeOptionalPositiveInteger(fileEntry?.contextWindowTokens);
  if (configured !== null) {
    return {
      contextWindowSource: "provider_config",
      contextWindowTokens: configured
    };
  }
  const customConfigured = normalizeOptionalPositiveInteger(customProvider.contextWindowTokens);
  return {
    contextWindowSource: customConfigured === null ? null : "custom_provider",
    contextWindowTokens: customConfigured
  };
}

function serializeCredentialEntries(credentials: ProviderCredentialFileEntry[]): ProviderCredentialConfigWriteResult["credentials"] {
  return credentials.map((credential, index) => ({
    apiKeyEnv: normalizeNullableString(credential.apiKeyEnv),
    cooldownUntil: normalizeNullableString(credential.cooldownUntil),
    disabled: credential.disabled === true,
    id: normalizeNullableString(credential.id) ?? `credential-${index + 1}`,
    lastFailure: normalizeNullableString(credential.lastFailure),
    priority: typeof credential.priority === "number" && Number.isFinite(credential.priority) ? credential.priority : index
  }));
}

function resolveProviderNameForCredentialWrite(
  providerSelection: string,
  fileConfig: ProviderConfigFile,
  cwd = process.cwd()
): string {
  const resolved = resolveProviderSelectionWithAliases(providerSelection, cwd);
  try {
    const parsed = parseProviderSelection(resolved);
    if (parsed.providerName !== null) {
      return parsed.providerName;
    }
  } catch {
    // Fall through to custom provider parsing.
  }
  const customProviders = normalizeCustomProviders(fileConfig.customProviders);
  const selection = resolveConfiguredProviderSelection(resolved, customProviders);
  if (selection.providerName !== null) {
    return selection.providerName;
  }
  const separatorIndex = Math.min(
    ...[":", "/"]
      .map((separator) => resolved.indexOf(separator))
      .filter((index) => index > 0)
  );
  if (Number.isFinite(separatorIndex)) {
    return resolved.slice(0, separatorIndex);
  }
  const normalized = normalizeNullableString(resolved);
  if (normalized === null) {
    throw new Error("Provider name is required.");
  }
  return normalized;
}
function resolveEntryCredentials(input: {
  credentials?: ProviderCredentialFileEntry[] | undefined;
  defaultsApiKey?: string | null | undefined;
  fileApiKey?: string | null | undefined;
  ignoreProviderEnv: boolean;
  requestedCredentialId?: string | undefined;
}): ResolvedProviderCredential[] {
  return resolveProviderCredentials({
    credentials: input.credentials,
    envApiKey: process.env.AGENT_PROVIDER_API_KEY,
    ignoreProviderEnv: input.ignoreProviderEnv,
    legacyApiKey: input.fileApiKey ?? input.defaultsApiKey,
    requestedCredentialId: input.requestedCredentialId
  });
}

function listAvailableCredentialIds(config: ResolvedProviderConfig): string[] {
  return config.credential.availableCredentialIds;
}

function hasConfiguredCredential(entry: ProviderFileEntry): boolean {
  if (normalizeNullableString(entry.apiKey) !== null) {
    return true;
  }
  for (const credential of entry.credentials ?? []) {
    if (credential.disabled === true) {
      continue;
    }
    if (normalizeNullableString(credential.apiKey) !== null) {
      return true;
    }
    const envName = normalizeNullableString(credential.apiKeyEnv);
    if (envName !== null && normalizeNullableString(process.env[envName]) !== null) {
      return true;
    }
  }
  return false;
}

function externalManifestsToCustomProviders(
  manifests: ExternalProviderManifest[]
): Record<string, CustomProviderFileEntry> {
  return manifests.reduce<Record<string, CustomProviderFileEntry>>((entries, manifest) => {
    entries[manifest.name] = {
      anthropicVersion: manifest.anthropicVersion,
      baseUrl: manifest.baseUrl,
      contextWindowTokens: manifest.contextWindowTokens,
      displayName: manifest.displayName,
      model: manifest.model,
      providerLabel: manifest.providerLabel,
      supportsStreaming: manifest.supportsStreaming,
      supportsToolCalls: manifest.supportsToolCalls,
      transport: manifest.transport
    };
    return entries;
  }, {});
}

function normalizeProviderEntries(
  providers: Record<string, ProviderFileEntry> | undefined,
  customProviders: Record<string, CustomProviderFileEntry>
): Record<string, ProviderFileEntry> {
  if (providers === undefined) {
    return {};
  }

  return Object.entries(providers).reduce<Record<string, ProviderFileEntry>>((entries, [key, value]) => {
      if (customProviders[key] !== undefined) {
        entries[key] = {
          ...(entries[key] ?? {}),
          ...value
        };
        return entries;
      }

      const normalized = normalizeProviderName(key);
      if (normalized === null) {
        return entries;
      }

      entries[normalized] = {
        ...(entries[normalized] ?? {}),
        ...value
      };
      return entries;
    }, {});
}

function normalizeCustomProviders(
  providers: Record<string, CustomProviderFileEntry> | undefined
): Record<string, CustomProviderFileEntry & { transport: Exclude<ProviderTransportKind, "mock"> }> {
  if (providers === undefined) {
    return {};
  }

  return Object.entries(providers).reduce<
    Record<string, CustomProviderFileEntry & { transport: Exclude<ProviderTransportKind, "mock"> }>
  >((entries, [key, value]) => {
    const name = key.trim();
    if (name.length === 0) {
      return entries;
    }

    if (normalizeProviderName(name) !== null) {
      return entries;
    }

    if (value.transport !== "openai-compatible" && value.transport !== "anthropic-compatible") {
      return entries;
    }

    entries[name] = {
      ...value,
      transport: value.transport
    };
    return entries;
  }, {});
}

function resolveConfiguredProviderSelection(
  value: string | null | undefined,
  customProviders: Record<string, CustomProviderFileEntry>
): { modelName: string | null; providerName: string | null } {
  try {
    const parsed = parseProviderSelection(value);
    if (parsed.providerName !== null) {
      return parsed;
    }
  } catch {
    // Fall through to custom provider resolution.
  }

  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return {
      modelName: null,
      providerName: null
    };
  }

  for (const separator of ["/", ":"]) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    const providerCandidate = normalized.slice(0, separatorIndex);
    if (customProviders[providerCandidate] === undefined) {
      continue;
    }

    return {
      modelName: normalizeNullableString(normalized.slice(separatorIndex + 1)),
      providerName: providerCandidate
    };
  }

  if (customProviders[normalized] !== undefined) {
    return {
      modelName: null,
      providerName: normalized
    };
  }

  throw new Error(`Unsupported provider "${normalized}".`);
}

function resolveCustomProviderModel(
  providerName: string,
  value: string | null | undefined
): string | null {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return null;
  }

  for (const separator of ["/", ":"]) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    if (normalized.slice(0, separatorIndex) !== providerName) {
      continue;
    }

    return normalizeNullableString(normalized.slice(separatorIndex + 1));
  }

  return normalized;
}

function normalizeOptionalPositiveInteger(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("provider contextWindowTokens must be a positive integer.");
  }
  return value;
}

function resolveSwitchableModelValue(
  ignoreProviderEnv: boolean,
  fileModel: string | null | undefined,
  selectionModel: string | null,
  fallback: string | null | undefined
): string | null {
  if (ignoreProviderEnv) {
    return selectionModel ?? normalizeNullableString(fileModel) ?? normalizeNullableString(fallback);
  }
  return (
    normalizeNullableString(process.env.AGENT_PROVIDER_MODEL) ??
    normalizeNullableString(fileModel) ??
    selectionModel ??
    normalizeNullableString(fallback)
  );
}

function resolveSwitchableEnvString(
  ignoreProviderEnv: boolean,
  envValue: string | undefined,
  fallback: string | null | undefined
): string | null | undefined {
  if (ignoreProviderEnv) {
    return fallback;
  }
  return envValue ?? fallback;
}

function resolveSwitchableEnvNumber(
  ignoreProviderEnv: boolean,
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number
): number | string | undefined {
  if (ignoreProviderEnv) {
    return fileValue ?? fallback;
  }
  return envValue ?? fileValue ?? fallback;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizePositiveNumber(value: number | string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return fallback;
}
