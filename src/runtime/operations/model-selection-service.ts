import type { JsonObject, SessionRecord } from "../../types/index.js";
import type { RuntimeConfig } from "../runtime-config.js";
import {
  listEnvOnlyProviderSelections,
  resolveMergedFallbackConfig,
  resolveMergedFallbackProviders,
  resolveMergedModelAliases,
  resolveProviderConfigForSwitch,
  type ConfiguredProviderNameEntry,
  type ResolvedProviderConfig
} from "../../providers/config.js";
import { listModelAliasEntries } from "../../providers/model-aliases.js";
import { isProviderSwitchable } from "../../providers/provider-switchable.js";
import { getModelFallbackStatus, type ModelFallbackStatus } from "../../providers/provider-failover.js";
import { formatProviderSelection, listConfiguredProviders } from "./provider-switch-service.js";

export type ModelSelectionSource =
  | "defaults"
  | "env"
  | "routing"
  | "runtime"
  | "session_user"
  | "user"
  | "workspace";

export interface SessionModelSelection extends JsonObject {
  selection: string;
  source: "session_user";
  updatedAt: string;
}

export interface ModelSelectionEntry extends JsonObject {
  baseUrl: string | null;
  configSource: ConfiguredProviderNameEntry["source"] | ResolvedProviderConfig["configSource"];
  contextWindowTokens: number | null;
  current: boolean;
  credential: ResolvedProviderConfig["credential"];
  displayName: string;
  model: string | null;
  providerName: string;
  selection: string;
  source: ModelSelectionSource;
  strict: boolean;
  transport: ResolvedProviderConfig["transport"];
}

export interface ModelSelectionView extends JsonObject {
  aliases: Array<{ alias: string; current: boolean; target: string }>;
  auxiliary: Record<string, string>;
  configuredModels: ModelSelectionEntry[];
  current: ModelSelectionEntry;
  envOnlyProviders: Array<{ selection: string }>;
  fallback: {
    auxiliary: Record<string, string[]>;
    main: string[];
    status: ModelFallbackStatus;
  };
  fallbackProviders: string[];
  routing: {
    helpers: RuntimeConfig["routing"]["helpers"];
    mode: RuntimeConfig["routing"]["mode"];
    providers: RuntimeConfig["routing"]["providers"];
  };
  session: {
    modelSelection: SessionModelSelection | null;
    sessionId: string | null;
  };
}

export function readSessionModelSelection(metadata: JsonObject): SessionModelSelection | null {
  const value = metadata.modelSelection;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.source !== "session_user" ||
    typeof candidate.selection !== "string" ||
    candidate.selection.trim().length === 0 ||
    typeof candidate.updatedAt !== "string" ||
    candidate.updatedAt.trim().length === 0
  ) {
    return null;
  }
  return {
    selection: candidate.selection.trim(),
    source: "session_user",
    updatedAt: candidate.updatedAt
  };
}

export function withSessionModelSelection(
  metadata: JsonObject,
  selection: string,
  updatedAt = new Date().toISOString()
): JsonObject {
  return {
    ...metadata,
    modelSelection: {
      selection,
      source: "session_user",
      updatedAt
    }
  };
}

export function withoutSessionModelSelection(metadata: JsonObject): JsonObject {
  const next = { ...metadata };
  delete next.modelSelection;
  delete next.providerSelection;
  return next;
}

export function createModelSelectionView(input: {
  currentProvider: ResolvedProviderConfig;
  cwd: string;
  runtimeConfig: RuntimeConfig;
  runtimeOverrideActive?: boolean;
  session?: SessionRecord | null;
}): ModelSelectionView {
  const sessionSelection =
    input.session === null || input.session === undefined
      ? null
      : readSessionModelSelection(input.session.metadata);
  const current = resolveCurrentSelection(input, sessionSelection);
  const configuredModels = listConfiguredProviders(input.cwd).map((entry) => {
    const selection = formatProviderSelection(entry.providerConfig);
    return toModelSelectionEntry({
      config: entry.providerConfig,
      configSource: entry.configSource,
      current: selection === current.selection,
      source: sourceFromProviderConfig(entry.providerConfig),
      strict: false
    });
  });
  const aliases = listModelAliasEntries(resolveMergedModelAliases(input.cwd)).map((entry) => ({
    alias: entry.alias,
    current: entry.alias === current.selection || entry.target === current.selection,
    target: entry.target
  }));

  const fallback = resolveMergedFallbackConfig(input.cwd);

  return {
    aliases,
    auxiliary: { ...input.runtimeConfig.auxiliary },
    configuredModels,
    current,
    envOnlyProviders: listEnvOnlyProviderSelections(input.cwd),
    fallback: {
      auxiliary: fallback.auxiliary,
      main: fallback.main,
      status: getModelFallbackStatus()
    },
    fallbackProviders: resolveMergedFallbackProviders(input.cwd),
    routing: {
      helpers: input.runtimeConfig.routing.helpers,
      mode: input.runtimeConfig.routing.mode,
      providers: input.runtimeConfig.routing.providers
    },
    session: {
      modelSelection: sessionSelection,
      sessionId: input.session?.sessionId ?? null
    }
  };
}

function resolveCurrentSelection(
  input: {
    currentProvider: ResolvedProviderConfig;
    cwd: string;
    runtimeConfig: RuntimeConfig;
  runtimeOverrideActive?: boolean;
  },
  sessionSelection: SessionModelSelection | null
): ModelSelectionEntry {
  if (sessionSelection !== null) {
    const config = resolveProviderConfigForSwitch(input.cwd, sessionSelection.selection);
    if (!isProviderSwitchable(config)) {
      throw new Error(
        `Session model selection "${sessionSelection.selection}" is not configured. Run talon provider setup first.`
      );
    }
    return toModelSelectionEntry({
      config,
      configSource: config.configSource,
      current: true,
      source: "session_user",
      strict: true
    });
  }

  if (input.runtimeOverrideActive === true) {
    return toModelSelectionEntry({
      config: input.currentProvider,
      configSource: input.currentProvider.configSource,
      current: true,
      source: "runtime",
      strict: false
    });
  }

  const routedProvider = resolveRoutedMainProvider(input.runtimeConfig.routing);
  if (routedProvider !== null) {
    const config = resolveProviderConfigForSwitch(input.cwd, routedProvider);
    if (isProviderSwitchable(config)) {
      return toModelSelectionEntry({
        config,
        configSource: config.configSource,
        current: true,
        source: "routing",
        strict: false
      });
    }
  }

  return toModelSelectionEntry({
    config: input.currentProvider,
    configSource: input.currentProvider.configSource,
    current: true,
    source: sourceFromProviderConfig(input.currentProvider),
    strict: false
  });
}

function resolveRoutedMainProvider(routing: RuntimeConfig["routing"]): string | null {
  const providers = routing.providers;
  if (
    providers.cheap === undefined &&
    providers.balanced === undefined &&
    providers.quality === undefined
  ) {
    return null;
  }
  if (routing.mode === "cheap_first") {
    return providers.cheap ?? providers.balanced ?? null;
  }
  if (routing.mode === "quality_first") {
    return providers.quality ?? providers.balanced ?? null;
  }
  return providers.balanced ?? providers.quality ?? providers.cheap ?? null;
}

function sourceFromProviderConfig(config: ResolvedProviderConfig): ModelSelectionSource {
  if (config.configSource === "file") {
    return "workspace";
  }
  return config.configSource;
}

function toModelSelectionEntry(input: {
  config: ResolvedProviderConfig;
  configSource: ModelSelectionEntry["configSource"];
  current: boolean;
  source: ModelSelectionSource;
  strict: boolean;
}): ModelSelectionEntry {
  return {
    baseUrl: input.config.baseUrl,
    configSource: input.configSource,
    contextWindowTokens: input.config.contextWindowTokens,
    credential: input.config.credential,
    current: input.current,
    displayName: input.config.displayName,
    model: input.config.model,
    providerName: input.config.name,
    selection: formatProviderSelection(input.config),
    source: input.source,
    strict: input.strict,
    transport: input.config.transport
  };
}

