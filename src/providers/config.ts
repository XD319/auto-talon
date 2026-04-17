import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonObject, ProviderConfig } from "../types";
import {
  type ProviderCatalogEntry,
  type ProviderTransportKind,
  type SupportedProviderName,
  normalizeProviderName,
  parseProviderSelection,
  resolveDefaultProviderSettings,
  requireProviderManifest,
  resolveProviderModel
} from "./provider-registry";

interface ProviderFileEntry extends JsonObject {
  apiKey?: string | null;
  baseUrl?: string | null;
  maxRetries?: number;
  model?: string | null;
  timeoutMs?: number;
}

interface ProviderConfigFile extends JsonObject {
  currentProvider?: string;
  providers?: Record<string, ProviderFileEntry>;
}

export interface ResolvedProviderConfig extends ProviderConfig {
  configPath: string;
  configSource: "defaults" | "env" | "file";
  displayName: string;
  family: ProviderTransportKind;
  transport: ProviderTransportKind;
}

export function resolveProviderConfig(cwd = process.cwd()): ResolvedProviderConfig {
  const configPath = join(resolve(cwd), ".tentaclaw", "provider.config.json");
  const fileConfig = loadProviderConfigFile(configPath);
  const providerEntries = normalizeProviderEntries(fileConfig.providers);
  const providerSelection = parseProviderSelection(
    process.env.AGENT_PROVIDER ?? fileConfig.currentProvider
  );
  const configuredName = providerSelection.providerName ?? "mock";
  const fileEntry = providerEntries[configuredName];

  let configSource: ResolvedProviderConfig["configSource"] = "defaults";
  if (fileConfig.currentProvider !== undefined || fileEntry !== undefined) {
    configSource = "file";
  }

  if (
    process.env.AGENT_PROVIDER !== undefined ||
    process.env.AGENT_PROVIDER_MODEL !== undefined ||
    process.env.AGENT_PROVIDER_BASE_URL !== undefined ||
    process.env.AGENT_PROVIDER_API_KEY !== undefined ||
    process.env.AGENT_PROVIDER_TIMEOUT_MS !== undefined ||
    process.env.AGENT_PROVIDER_MAX_RETRIES !== undefined
  ) {
    configSource = "env";
  }

  const manifest = requireProviderManifest(configuredName);
  const defaults = resolveDefaultProviderSettings(configuredName);
  const model = resolveProviderModel(
    configuredName,
    process.env.AGENT_PROVIDER_MODEL ?? fileEntry?.model ?? providerSelection.modelName ?? defaults.model
  );

  return {
    apiKey: normalizeNullableString(
      process.env.AGENT_PROVIDER_API_KEY ?? fileEntry?.apiKey ?? defaults.apiKey
    ),
    baseUrl: normalizeNullableString(
      process.env.AGENT_PROVIDER_BASE_URL ?? fileEntry?.baseUrl ?? defaults.baseUrl
    ),
    configPath,
    configSource,
    maxRetries: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_MAX_RETRIES ?? fileEntry?.maxRetries,
      defaults.maxRetries
    ),
    model,
    name: configuredName,
    displayName: manifest.displayName,
    family: manifest.family,
    timeoutMs: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_TIMEOUT_MS ?? fileEntry?.timeoutMs,
      defaults.timeoutMs
    ),
    transport: manifest.transport
  };
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

function normalizeProviderEntries(
  providers: Record<string, ProviderFileEntry> | undefined
): Partial<Record<SupportedProviderName, ProviderFileEntry>> {
  if (providers === undefined) {
    return {};
  }

  return Object.entries(providers).reduce<Partial<Record<SupportedProviderName, ProviderFileEntry>>>(
    (entries, [key, value]) => {
      const normalized = normalizeProviderName(key);
      if (normalized === null) {
        return entries;
      }

      entries[normalized] = {
        ...(entries[normalized] ?? {}),
        ...value
      };
      return entries;
    },
    {}
  );
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
