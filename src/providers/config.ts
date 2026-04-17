import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonObject, ProviderConfig } from "../types";

export const SUPPORTED_PROVIDER_NAMES = ["mock", "glm"] as const;

export type SupportedProviderName = (typeof SUPPORTED_PROVIDER_NAMES)[number];

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

export interface ProviderCatalogEntry {
  displayName: string;
  name: SupportedProviderName;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
}

export interface ResolvedProviderConfig extends ProviderConfig {
  configPath: string;
  configSource: "defaults" | "env" | "file";
}

const DEFAULT_PROVIDER_SETTINGS: Record<SupportedProviderName, Omit<ProviderConfig, "name">> = {
  glm: {
    apiKey: null,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    maxRetries: 2,
    model: "glm-4.5-air",
    timeoutMs: 30_000
  },
  mock: {
    apiKey: null,
    baseUrl: null,
    maxRetries: 0,
    model: "mock-default",
    timeoutMs: 5_000
  }
};

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    displayName: "Mock Provider",
    name: "mock",
    supportsConfiguration: true,
    supportsStreaming: false,
    supportsToolCalls: true
  },
  {
    displayName: "GLM",
    name: "glm",
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true
  }
];

export function resolveProviderConfig(cwd = process.cwd()): ResolvedProviderConfig {
  const configPath = join(resolve(cwd), ".tentaclaw", "provider.config.json");
  const fileConfig = loadProviderConfigFile(configPath);
  const configuredName = normalizeProviderName(
    process.env.AGENT_PROVIDER ?? fileConfig.currentProvider ?? "mock"
  );
  const fileEntry = fileConfig.providers?.[configuredName];

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

  const defaults = DEFAULT_PROVIDER_SETTINGS[configuredName];

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
    model: normalizeNullableString(
      process.env.AGENT_PROVIDER_MODEL ?? fileEntry?.model ?? defaults.model
    ),
    name: configuredName,
    timeoutMs: normalizePositiveNumber(
      process.env.AGENT_PROVIDER_TIMEOUT_MS ?? fileEntry?.timeoutMs,
      defaults.timeoutMs
    )
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

function normalizeProviderName(name: string): SupportedProviderName {
  const normalized = name.trim().toLowerCase();
  return normalized === "glm" ? "glm" : "mock";
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
