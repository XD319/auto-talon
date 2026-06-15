import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { JsonObject, ProviderConfig } from "../types/index.js";
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
  maxRetries?: number;
  model?: string | null;
  streamIdleTimeoutMs?: number;
  timeoutMs?: number;
}

interface CustomProviderFileEntry extends ProviderFileEntry {
  anthropicVersion?: string | null;
  displayName?: string | null;
  providerLabel?: string | null;
  transport?: Exclude<ProviderTransportKind, "mock">;
}

interface ProviderConfigFile extends JsonObject {
  currentProvider?: string;
  customProviders?: Record<string, CustomProviderFileEntry>;
  providers?: Record<string, ProviderFileEntry>;
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

function resolveProviderConfigInternal(
  cwd: string,
  options: {
    includeProviderSelectionEnv: boolean;
    providerSelection?: string;
  }
): ResolvedProviderConfig {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfigPath = resolveUserProviderConfigPath();
  const userConfig = loadProviderConfigFile(userConfigPath);
  const workspaceConfig = loadProviderConfigFile(workspaceConfigPath);
  const fileConfig = mergeProviderConfigFiles(userConfig, workspaceConfig);
  const customProviders = normalizeCustomProviders(fileConfig.customProviders);
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
    options.includeProviderSelectionEnv
  );
  const configPath = resolveConfigPath(configSource, userConfigPath, workspaceConfigPath);

  if (builtinProviderName !== null) {
    const manifest = requireProviderManifest(builtinProviderName);
    const defaults = resolveDefaultProviderSettings(builtinProviderName);
    const model = resolveProviderModel(
      builtinProviderName,
      process.env.AGENT_PROVIDER_MODEL ??
        fileEntry?.model ??
        providerSelection.modelName ??
        defaults.model
    );

    return {
      apiKey: normalizeNullableString(
        process.env.AGENT_PROVIDER_API_KEY ?? fileEntry?.apiKey ?? defaults.apiKey
      ),
      baseUrl: normalizeNullableString(
        process.env.AGENT_PROVIDER_BASE_URL ?? fileEntry?.baseUrl ?? defaults.baseUrl
      ),
      builtinProviderName,
      configPath,
      configSource,
      maxRetries: normalizePositiveNumber(
        process.env.AGENT_PROVIDER_MAX_RETRIES ?? fileEntry?.maxRetries,
        defaults.maxRetries
      ),
      model,
      name: configuredName,
      configured: true,
      ...resolveBuiltinContextWindow(fileEntry, builtinProviderName, model, manifest),
      displayName: manifest.displayName,
      family: manifest.family,
      streamIdleTimeoutConfigured:
        process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS !== undefined ||
        fileEntry?.streamIdleTimeoutMs !== undefined,
      streamIdleTimeoutMs: normalizePositiveNumber(
        process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS ?? fileEntry?.streamIdleTimeoutMs,
        defaults.streamIdleTimeoutMs
      ),
      timeoutConfigured:
        process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined || fileEntry?.timeoutMs !== undefined,
      timeoutMs: normalizePositiveNumber(
        process.env.AGENT_PROVIDER_TIMEOUT_MS ?? fileEntry?.timeoutMs,
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
    process.env.AGENT_PROVIDER_MODEL ??
      fileEntry?.model ??
      providerSelection.modelName ??
      customProvider.model
  );

  return {
    anthropicVersion: normalizeNullableString(customProvider.anthropicVersion),
    apiKey: normalizeNullableString(
      process.env.AGENT_PROVIDER_API_KEY ?? fileEntry?.apiKey ?? customProvider.apiKey
    ),
    baseUrl: normalizeNullableString(
      process.env.AGENT_PROVIDER_BASE_URL ?? fileEntry?.baseUrl ?? customProvider.baseUrl
    ),
    builtinProviderName: null,
    configPath,
    configSource,
    maxRetries: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_MAX_RETRIES ?? fileEntry?.maxRetries,
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
    streamIdleTimeoutConfigured:
      process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS !== undefined ||
      fileEntry?.streamIdleTimeoutMs !== undefined ||
      customProvider.streamIdleTimeoutMs !== undefined,
    streamIdleTimeoutMs: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_STREAM_IDLE_TIMEOUT_MS ?? fileEntry?.streamIdleTimeoutMs,
      normalizePositiveNumber(customProvider.streamIdleTimeoutMs, 300_000)
    ),
    timeoutConfigured:
      process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined ||
      fileEntry?.timeoutMs !== undefined ||
      customProvider.timeoutMs !== undefined,
    timeoutMs: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_TIMEOUT_MS ?? fileEntry?.timeoutMs,
      normalizePositiveNumber(customProvider.timeoutMs, 120_000)
    ),
    transport: customProvider.transport
  };
}

export function resolveProviderCatalog(cwd = process.cwd()): ProviderCatalogEntry[] {
  const workspaceConfigPath = join(resolve(cwd), ".auto-talon", "provider.config.json");
  const userConfigPath = resolveUserProviderConfigPath();
  const fileConfig = mergeProviderConfigFiles(
    loadProviderConfigFile(userConfigPath),
    loadProviderConfigFile(workspaceConfigPath)
  );
  const customProviders = normalizeCustomProviders(fileConfig.customProviders);

  return [
    ...PROVIDER_CATALOG,
    ...Object.entries(customProviders).map(([name, provider]) => ({
      aliases: [],
      contextWindowTokens: normalizeOptionalPositiveInteger(provider.contextWindowTokens) ?? null,
      displayName: normalizeNullableString(provider.displayName) ?? name,
      family: provider.transport,
      name,
      supportsConfiguration: true,
      supportsStreaming: true,
      supportsToolCalls: true,
      transport: provider.transport
    }))
  ];
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
  return writeProviderConfig(providerSelection, options, {
    writeSetupEntry: false
  });
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

function loadProviderConfigFile(configPath: string): ProviderConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf8").trim();
  if (content.length === 0) {
    return {};
  }

  const parsed = JSON.parse(content) as ProviderConfigFile;
  return parsed;
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
  const configPath = resolveProviderConfigPath(scope, options.cwd);
  const fileConfig = loadProviderConfigFile(configPath);
  const selection = resolveConfiguredProviderSelection(
    providerSelection,
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

  return {
    ...userConfig,
    ...workspaceConfig,
    ...(workspaceConfig.currentProvider !== undefined
      ? { currentProvider: workspaceConfig.currentProvider }
      : userConfig.currentProvider !== undefined
        ? { currentProvider: userConfig.currentProvider }
        : {}),
    ...(customProviders !== undefined ? { customProviders } : {}),
    ...(providers !== undefined ? { providers } : {})
  };
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
    displayName: "Provider not configured",
    family: "mock",
    maxRetries: 0,
    model: null,
    name: "unconfigured",
    streamIdleTimeoutConfigured: false,
    streamIdleTimeoutMs: 5_000,
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
