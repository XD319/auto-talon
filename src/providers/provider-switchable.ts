import type { ResolvedProviderConfig } from "./config.js";

export function isProviderSwitchable(config: ResolvedProviderConfig): boolean {
  if (config.configured === false) {
    return false;
  }
  if (config.name === "mock" || config.builtinProviderName === "ollama") {
    return true;
  }
  const credential = (config as { credential?: ResolvedProviderConfig["credential"] }).credential;
  if (credential?.credentialStatus === "available") {
    return true;
  }
  if (config.apiKey !== null && config.apiKey.length > 0) {
    return true;
  }
  if (
    config.builtinProviderName === null &&
    config.baseUrl !== null &&
    config.baseUrl.length > 0 &&
    (credential?.credentialCount ?? 0) === 0
  ) {
    return true;
  }
  return false;
}