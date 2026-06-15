import type { Provider } from "../types/index.js";
import type { ResolvedProviderConfig } from "./config.js";
import type { RuntimeConfig } from "../runtime/runtime-config.js";

import { CONTEXT_WINDOW_FETCH_TIMEOUT_MS } from "./context-window-query.js";

export function shouldFetchContextWindowFromApi(
  provider: ResolvedProviderConfig,
  runtimeConfig: Pick<RuntimeConfig, "tokenBudgetInputLimitExplicit">
): boolean {
  if (runtimeConfig.tokenBudgetInputLimitExplicit) {
    return false;
  }
  if (provider.configured === false) {
    return false;
  }
  if (provider.contextWindowSource === "provider_config") {
    return false;
  }
  return true;
}

export async function enrichProviderContextFromApi(
  provider: Provider,
  providerConfig: ResolvedProviderConfig,
  runtimeConfig: Pick<RuntimeConfig, "tokenBudgetInputLimitExplicit">
): Promise<ResolvedProviderConfig> {
  if (!shouldFetchContextWindowFromApi(providerConfig, runtimeConfig)) {
    return providerConfig;
  }
  if (provider.fetchContextWindow === undefined) {
    return providerConfig;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, CONTEXT_WINDOW_FETCH_TIMEOUT_MS);

  try {
    const tokens = await provider.fetchContextWindow(controller.signal);
    if (tokens !== null && Number.isInteger(tokens) && tokens > 0) {
      return {
        ...providerConfig,
        contextWindowSource: "provider_api",
        contextWindowTokens: tokens
      };
    }
  } catch {
    // Best-effort API lookup; fall back to static manifest/model map.
  } finally {
    clearTimeout(timeout);
  }

  return providerConfig;
}
