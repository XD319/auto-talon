import type { ProviderConfig } from "../types";

export const SUPPORTED_PROVIDER_NAMES = ["mock", "glm", "openai-compatible"] as const;

export type SupportedProviderName = (typeof SUPPORTED_PROVIDER_NAMES)[number];

export type ProviderTransportKind = "mock" | "openai-compatible";

export interface ProviderCatalogEntry {
  aliases: string[];
  displayName: string;
  family: ProviderTransportKind;
  name: SupportedProviderName;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  transport: ProviderTransportKind;
}

export interface ProviderManifest {
  aliases: string[];
  displayName: string;
  family: ProviderTransportKind;
  name: SupportedProviderName;
  openAiCompatible?:
    | {
        defaultBaseUrl: string | null;
        defaultDisplayName: string;
        defaultModel: string;
        providerLabel?: string;
      }
    | undefined;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  transport: ProviderTransportKind;
}

export interface ProviderSelection {
  modelName: string | null;
  providerName: SupportedProviderName | null;
}

const DEFAULT_PROVIDER_SETTINGS: Record<SupportedProviderName, Omit<ProviderConfig, "name">> = {
  glm: {
    apiKey: null,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    maxRetries: 2,
    model: "glm-4.5-air",
    timeoutMs: 30_000
  },
  "openai-compatible": {
    apiKey: null,
    baseUrl: null,
    maxRetries: 2,
    model: "gpt-4o-mini",
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

const PROVIDER_MANIFESTS: Record<SupportedProviderName, ProviderManifest> = {
  glm: {
    aliases: ["z.ai", "z-ai", "zhipu"],
    displayName: "GLM",
    family: "openai-compatible",
    name: "glm",
    openAiCompatible: {
      defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultDisplayName: "GLM",
      defaultModel: "glm-4.5-air",
      providerLabel: "GLM"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  "openai-compatible": {
    aliases: ["compatible", "custom", "custom-openai", "openai", "openai_compatible"],
    displayName: "OpenAI Compatible",
    family: "openai-compatible",
    name: "openai-compatible",
    openAiCompatible: {
      defaultBaseUrl: null,
      defaultDisplayName: "OpenAI Compatible",
      defaultModel: "gpt-4o-mini"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    transport: "openai-compatible"
  },
  mock: {
    aliases: [],
    displayName: "Mock Provider",
    family: "mock",
    name: "mock",
    supportsConfiguration: true,
    supportsStreaming: false,
    supportsToolCalls: true,
    transport: "mock"
  }
};

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = SUPPORTED_PROVIDER_NAMES.map((name) => {
  const manifest = PROVIDER_MANIFESTS[name];
  return {
    aliases: [...manifest.aliases],
    displayName: manifest.displayName,
    family: manifest.family,
    name: manifest.name,
    supportsConfiguration: manifest.supportsConfiguration,
    supportsStreaming: manifest.supportsStreaming,
    supportsToolCalls: manifest.supportsToolCalls,
    transport: manifest.transport
  };
});

export function listProviderManifests(): ProviderManifest[] {
  return SUPPORTED_PROVIDER_NAMES.map((name) => PROVIDER_MANIFESTS[name]);
}

export function resolveProviderManifest(name: string): ProviderManifest | null {
  const normalized = normalizeProviderName(name);
  return normalized === null ? null : PROVIDER_MANIFESTS[normalized];
}

export function requireProviderManifest(name: string): ProviderManifest {
  const manifest = resolveProviderManifest(name);
  if (manifest === null) {
    throw new Error(
      `Unsupported provider "${name}". Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`
    );
  }

  return manifest;
}

export function resolveDefaultProviderSettings(
  name: SupportedProviderName
): Omit<ProviderConfig, "name"> {
  return DEFAULT_PROVIDER_SETTINGS[name];
}

export function normalizeProviderName(name: string): SupportedProviderName | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  for (const providerName of SUPPORTED_PROVIDER_NAMES) {
    if (normalized === providerName) {
      return providerName;
    }

    const manifest = PROVIDER_MANIFESTS[providerName];
    if (manifest.aliases.some((alias) => alias.toLowerCase() === normalized)) {
      return providerName;
    }
  }

  return null;
}

export function parseProviderSelection(value: string | null | undefined): ProviderSelection {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return {
      modelName: null,
      providerName: null
    };
  }

  const separators = ["/", ":"];
  for (const separator of separators) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    const providerCandidate = normalized.slice(0, separatorIndex);
    const providerName = normalizeProviderName(providerCandidate);
    if (providerName === null) {
      continue;
    }

    const rawModelName = normalizeNullableString(normalized.slice(separatorIndex + 1));
    return {
      modelName: rawModelName,
      providerName
    };
  }

  return {
    modelName: null,
    providerName: requireSupportedProvider(normalized)
  };
}

export function resolveProviderModel(
  providerName: SupportedProviderName,
  value: string | null | undefined
): string | null {
  const normalized = normalizeNullableString(value);
  if (normalized === null) {
    return null;
  }

  const parsed = parseModelReference(normalized);
  if (parsed.providerName === null) {
    return parsed.modelName;
  }

  if (parsed.providerName !== providerName) {
    throw new Error(
      `Configured model reference "${normalized}" does not match provider "${providerName}".`
    );
  }

  return parsed.modelName;
}

function parseModelReference(value: string): ProviderSelection {
  const separators = ["/", ":"];
  for (const separator of separators) {
    const separatorIndex = value.indexOf(separator);
    if (separatorIndex <= 0) {
      continue;
    }

    const providerCandidate = value.slice(0, separatorIndex);
    const providerName = normalizeProviderName(providerCandidate);
    if (providerName === null) {
      continue;
    }

    return {
      modelName: normalizeNullableString(value.slice(separatorIndex + 1)),
      providerName
    };
  }

  return {
    modelName: value,
    providerName: null
  };
}

function requireSupportedProvider(value: string): SupportedProviderName {
  const normalized = normalizeProviderName(value);
  if (normalized === null) {
    throw new Error(
      `Unsupported provider "${value}". Supported providers: ${SUPPORTED_PROVIDER_NAMES.join(", ")}.`
    );
  }

  return normalized;
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}
