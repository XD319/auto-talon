import type { ProviderConfig } from "../types/index.js";

export const SUPPORTED_PROVIDER_NAMES = [
  "mock",
  "xfyun-coding",
  "openai-compatible",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
  "ollama",
  "glm",
  "moonshot",
  "minimax",
  "qwen",
  "xai"
] as const;

export type SupportedProviderName = (typeof SUPPORTED_PROVIDER_NAMES)[number];

export type ProviderTransportKind = "anthropic-compatible" | "mock" | "openai-compatible";
export const SUPPORTED_PROVIDER_CONTRACT_VERSION = 1;

export interface ProviderCatalogEntry {
  aliases: string[];
  contextWindowTokens: number | null;
  displayName: string;
  family: ProviderTransportKind;
  name: string;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  transport: ProviderTransportKind;
}

export interface ProviderManifest {
  aliases: string[];
  anthropicCompatible?:
    | {
        anthropicVersion?: string;
        defaultBaseUrl: string | null;
        defaultDisplayName: string;
        defaultModel: string;
        providerLabel?: string;
      }
    | undefined;
  displayName: string;
  family: ProviderTransportKind;
  contextWindowTokens: number | null;
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
  contractVersion: number;
  transport: ProviderTransportKind;
}

export interface ProviderSelection {
  modelName: string | null;
  providerName: SupportedProviderName | null;
}

const DEFAULT_PROVIDER_SETTINGS: Record<SupportedProviderName, Omit<ProviderConfig, "name">> = {
  anthropic: {
    apiKey: null,
    baseUrl: "https://api.anthropic.com",
    maxRetries: 2,
    model: "claude-sonnet-4-20250514",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  "xfyun-coding": {
    apiKey: null,
    baseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
    maxRetries: 2,
    model: "astron-code-latest",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  gemini: {
    apiKey: null,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    maxRetries: 2,
    model: "gemini-2.5-flash",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  glm: {
    apiKey: null,
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    maxRetries: 2,
    model: "glm-4.5-air",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  "openai-compatible": {
    apiKey: null,
    baseUrl: null,
    maxRetries: 2,
    model: "gpt-4o-mini",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  openai: {
    apiKey: null,
    baseUrl: "https://api.openai.com/v1",
    maxRetries: 2,
    model: "gpt-4o-mini",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  ollama: {
    apiKey: "ollama",
    baseUrl: "http://localhost:11434/v1",
    maxRetries: 1,
    model: "llama3.2",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 60_000
  },
  openrouter: {
    apiKey: null,
    baseUrl: "https://openrouter.ai/api/v1",
    maxRetries: 2,
    model: "openai/gpt-4o-mini",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  minimax: {
    apiKey: null,
    baseUrl: "https://api.minimax.io/anthropic",
    maxRetries: 2,
    model: "MiniMax-M2.7",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  moonshot: {
    apiKey: null,
    baseUrl: "https://api.moonshot.ai/v1",
    maxRetries: 2,
    model: "kimi-k2.5",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  mock: {
    apiKey: null,
    baseUrl: null,
    maxRetries: 0,
    model: "mock-default",
    streamIdleTimeoutMs: 5_000,
    timeoutMs: 5_000
  },
  qwen: {
    apiKey: null,
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    maxRetries: 2,
    model: "qwen-plus",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  },
  xai: {
    apiKey: null,
    baseUrl: "https://api.x.ai/v1",
    maxRetries: 2,
    model: "grok-4.20-reasoning",
    streamIdleTimeoutMs: 300_000,
    timeoutMs: 120_000
  }
};

const PROVIDER_MANIFESTS: Record<SupportedProviderName, ProviderManifest> = {
  anthropic: {
    aliases: ["claude"],
    anthropicCompatible: {
      anthropicVersion: "2023-06-01",
      defaultBaseUrl: "https://api.anthropic.com",
      defaultDisplayName: "Anthropic",
      defaultModel: "claude-sonnet-4-20250514",
      providerLabel: "Anthropic"
    },
    contextWindowTokens: 200_000,
    displayName: "Anthropic",
    family: "anthropic-compatible",
    name: "anthropic",
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "anthropic-compatible"
  },
  "xfyun-coding": {
    aliases: ["astron", "iflytek", "spark-coding", "xfyun"],
    contextWindowTokens: 64_000,
    displayName: "iFLYTEK Coding Plan",
    family: "openai-compatible",
    name: "xfyun-coding",
    openAiCompatible: {
      defaultBaseUrl: "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
      defaultDisplayName: "iFLYTEK Coding Plan",
      defaultModel: "astron-code-latest",
      providerLabel: "iFLYTEK Coding Plan"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  gemini: {
    aliases: ["google"],
    contextWindowTokens: 1_000_000,
    displayName: "Gemini",
    family: "openai-compatible",
    name: "gemini",
    openAiCompatible: {
      defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      defaultDisplayName: "Gemini",
      defaultModel: "gemini-2.5-flash",
      providerLabel: "Gemini"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  glm: {
    aliases: ["z.ai", "z-ai", "zhipu"],
    contextWindowTokens: 128_000,
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
    contractVersion: 1,
    transport: "openai-compatible"
  },
  minimax: {
    aliases: ["mini-max"],
    anthropicCompatible: {
      anthropicVersion: "2023-06-01",
      defaultBaseUrl: "https://api.minimax.io/anthropic",
      defaultDisplayName: "MiniMax",
      defaultModel: "MiniMax-M2.7",
      providerLabel: "MiniMax"
    },
    contextWindowTokens: 200_000,
    displayName: "MiniMax",
    family: "anthropic-compatible",
    name: "minimax",
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "anthropic-compatible"
  },
  moonshot: {
    aliases: ["kimi"],
    contextWindowTokens: 128_000,
    displayName: "Moonshot",
    family: "openai-compatible",
    name: "moonshot",
    openAiCompatible: {
      defaultBaseUrl: "https://api.moonshot.ai/v1",
      defaultDisplayName: "Moonshot",
      defaultModel: "kimi-k2.5",
      providerLabel: "Moonshot"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  "openai-compatible": {
    aliases: ["compatible", "custom", "custom-openai", "openai_compatible"],
    contextWindowTokens: null,
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
    contractVersion: 1,
    transport: "openai-compatible"
  },
  openai: {
    aliases: ["openai-api"],
    contextWindowTokens: 128_000,
    displayName: "OpenAI",
    family: "openai-compatible",
    name: "openai",
    openAiCompatible: {
      defaultBaseUrl: "https://api.openai.com/v1",
      defaultDisplayName: "OpenAI",
      defaultModel: "gpt-4o-mini",
      providerLabel: "OpenAI"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  ollama: {
    aliases: ["local"],
    contextWindowTokens: null,
    displayName: "Ollama",
    family: "openai-compatible",
    name: "ollama",
    openAiCompatible: {
      defaultBaseUrl: "http://localhost:11434/v1",
      defaultDisplayName: "Ollama",
      defaultModel: "llama3.2",
      providerLabel: "Ollama"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  openrouter: {
    aliases: ["router"],
    contextWindowTokens: null,
    displayName: "OpenRouter",
    family: "openai-compatible",
    name: "openrouter",
    openAiCompatible: {
      defaultBaseUrl: "https://openrouter.ai/api/v1",
      defaultDisplayName: "OpenRouter",
      defaultModel: "openai/gpt-4o-mini",
      providerLabel: "OpenRouter"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  mock: {
    aliases: [],
    contextWindowTokens: 64_000,
    displayName: "Mock Provider",
    family: "mock",
    name: "mock",
    supportsConfiguration: true,
    supportsStreaming: false,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "mock"
  },
  qwen: {
    aliases: ["aliyun", "dashscope", "tongyi"],
    contextWindowTokens: 128_000,
    displayName: "Qwen",
    family: "openai-compatible",
    name: "qwen",
    openAiCompatible: {
      defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultDisplayName: "Qwen",
      defaultModel: "qwen-plus",
      providerLabel: "Qwen"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  },
  xai: {
    aliases: ["grok", "x.ai"],
    contextWindowTokens: 256_000,
    displayName: "xAI",
    family: "openai-compatible",
    name: "xai",
    openAiCompatible: {
      defaultBaseUrl: "https://api.x.ai/v1",
      defaultDisplayName: "xAI",
      defaultModel: "grok-4.20-reasoning",
      providerLabel: "xAI"
    },
    supportsConfiguration: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    contractVersion: 1,
    transport: "openai-compatible"
  }
};

const MODEL_CONTEXT_WINDOWS: Partial<Record<SupportedProviderName, Record<string, number>>> = {
  anthropic: {
    "claude-haiku-3-5-20241022": 200_000,
    "claude-opus-4-20250514": 200_000,
    "claude-sonnet-4-20250514": 200_000,
    "claude-sonnet-4-*": 200_000,
    "claude-opus-4-*": 200_000,
    "claude-haiku-3-5-*": 200_000
  },
  gemini: {
    "gemini-2.5-flash": 1_048_576,
    "gemini-2.5-pro": 1_048_576,
    "gemini-2.0-flash": 1_048_576,
    "gemini-2.0-pro": 1_048_576,
    "gemini-1.5-flash": 1_048_576,
    "gemini-1.5-pro": 1_048_576
  },
  glm: {
    "glm-4.5-air": 128_000,
    "glm-4.5": 128_000,
    "glm-4-plus": 128_000,
    "glm-4": 128_000
  },
  minimax: {
    "MiniMax-M2.7": 200_000,
    "MiniMax-M2": 200_000,
    "MiniMax-M2.5": 200_000
  },
  moonshot: {
    "kimi-k2.5": 128_000,
    "kimi-k2": 128_000,
    "moonshot-v1-128k": 128_000,
    "moonshot-v1-32k": 32_000,
    "moonshot-v1-8k": 8_000
  },
  openai: {
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
    "gpt-4-turbo": 128_000,
    "gpt-4": 128_000,
    "o1": 200_000,
    "o1-mini": 128_000,
    "o1-preview": 128_000,
    "o3": 200_000,
    "o3-mini": 200_000,
    "o4-mini": 200_000
  },
  qwen: {
    "qwen-plus": 128_000,
    "qwen-turbo": 128_000,
    "qwen-max": 128_000,
    "qwen-long": 1_000_000
  },
  xai: {
    "grok-4.20-reasoning": 256_000,
    "grok-3": 131_072,
    "grok-2": 131_072
  },
  "xfyun-coding": {
    "astron-code-latest": 64_000,
    "astron-code-*": 64_000
  }
};

export type ModelContextWindowSource = "provider_model_manifest" | "provider_manifest";

export function resolveModelContextWindow(
  providerName: SupportedProviderName,
  model: string | null,
  manifestDefault: number | null
): { contextWindowTokens: number | null; source: ModelContextWindowSource | null } {
  if (model === null) {
    return {
      contextWindowTokens: manifestDefault,
      source: manifestDefault === null ? null : "provider_manifest"
    };
  }

  const modelMap = MODEL_CONTEXT_WINDOWS[providerName];
  if (modelMap !== undefined) {
    if (modelMap[model] !== undefined) {
      return {
        contextWindowTokens: modelMap[model],
        source: "provider_model_manifest"
      };
    }

    for (const [pattern, tokens] of Object.entries(modelMap)) {
      if (!pattern.endsWith("*")) {
        continue;
      }
      const prefix = pattern.slice(0, -1);
      if (model.startsWith(prefix)) {
        return {
          contextWindowTokens: tokens,
          source: "provider_model_manifest"
        };
      }
    }
  }

  return {
    contextWindowTokens: manifestDefault,
    source: manifestDefault === null ? null : "provider_manifest"
  };
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = SUPPORTED_PROVIDER_NAMES.map((name) => {
  const manifest = PROVIDER_MANIFESTS[name];
  return {
    aliases: [...manifest.aliases],
    contextWindowTokens: manifest.contextWindowTokens,
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

export function assertProviderManifestCompatibility(manifest: ProviderManifest): void {
  if (manifest.contractVersion > SUPPORTED_PROVIDER_CONTRACT_VERSION) {
    throw new Error(
      `Provider "${manifest.name}" requires contract version ${manifest.contractVersion}, ` +
        `but this runtime only supports up to ${SUPPORTED_PROVIDER_CONTRACT_VERSION}. ` +
        "Please upgrade auto-talon."
    );
  }
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
