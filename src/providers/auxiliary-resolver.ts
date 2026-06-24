import type { Provider } from "../types/index.js";
import type { ProviderRouter } from "./routing/provider-router.js";
import type { RouteKind } from "../types/index.js";
import {
  resolveProviderConfigForProvider,
  resolveProviderSelectionWithAliases,
  type ResolvedProviderConfig
} from "./config.js";

export type AuxiliarySlot = "classify" | "compression" | "recallRank" | "summarize" | "title" | "vision";

export const AUXILIARY_SLOTS: AuxiliarySlot[] = [
  "classify",
  "compression",
  "recallRank",
  "summarize",
  "title",
  "vision"
];

export type AuxiliarySlotValue = "auto" | (string & {});

export interface AuxiliaryRuntimeConfig {
  classify: AuxiliarySlotValue;
  compression: AuxiliarySlotValue;
  recallRank: AuxiliarySlotValue;
  summarize: AuxiliarySlotValue;
  title: AuxiliarySlotValue;
  vision: AuxiliarySlotValue;
}

export const DEFAULT_AUXILIARY_CONFIG: AuxiliaryRuntimeConfig = {
  classify: "auto",
  compression: "auto",
  recallRank: "auto",
  summarize: "auto",
  title: "auto",
  vision: "auto"
};

export interface AuxiliaryProviderResolver {
  clearProviderCache(): void;
  resolve(slot: AuxiliarySlot, context: { sessionId: string | null; taskId: string }): Provider;
  setMainProvider(provider: Provider): void;
}

export function normalizeAuxiliaryConfig(
  input: Partial<Record<keyof AuxiliaryRuntimeConfig, string | null | undefined>> | undefined
): AuxiliaryRuntimeConfig {
  const normalizeSlot = (value: string | null | undefined): AuxiliarySlotValue => {
    if (value === undefined || value === null) {
      return "auto";
    }
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed.toLowerCase() === "auto" ? "auto" : trimmed;
  };

  return {
    classify: normalizeSlot(input?.classify),
    compression: normalizeSlot(input?.compression),
    recallRank: normalizeSlot(input?.recallRank),
    summarize: normalizeSlot(input?.summarize),
    title: normalizeSlot(input?.title),
    vision: normalizeSlot(input?.vision)
  };
}

function auxiliarySlotToRouteKind(slot: AuxiliarySlot): RouteKind {
  if (slot === "compression" || slot === "summarize" || slot === "title" || slot === "vision") {
    return "summarize";
  }
  if (slot === "classify") {
    return "classify";
  }
  return "recall_rank";
}

export function createAuxiliaryProviderResolver(input: {
  auxiliary: AuxiliaryRuntimeConfig;
  createProvider: (config: ResolvedProviderConfig) => Provider;
  cwd: string;
  mainProviderRef: { current: Provider };
  providerRouter?: ProviderRouter;
}): AuxiliaryProviderResolver {
  const providerCache = new Map<string, Provider>();

  const resolveConfiguredProvider = (selection: string): Provider => {
    const resolvedSelection = resolveProviderSelectionWithAliases(selection, input.cwd);
    const cached = providerCache.get(resolvedSelection);
    if (cached !== undefined) {
      return cached;
    }
    const config = resolveProviderConfigForProvider(input.cwd, resolvedSelection);
    const provider = input.createProvider(config);
    providerCache.set(resolvedSelection, provider);
    return provider;
  };

  return {
    clearProviderCache() {
      providerCache.clear();
    },
    resolve(slot, context) {
      const selection = input.auxiliary[slot];
      if (selection !== "auto") {
        return resolveConfiguredProvider(selection);
      }

      const routeKind = auxiliarySlotToRouteKind(slot);
      const routed = input.providerRouter?.selectProvider({
        kind: routeKind,
        sessionId: context.sessionId,
        taskId: context.taskId
      });
      if (routed?.provider !== null && routed?.provider !== undefined) {
        return routed.provider;
      }

      return input.mainProviderRef.current;
    },
    setMainProvider(provider) {
      input.mainProviderRef.current = provider;
    }
  };
}
