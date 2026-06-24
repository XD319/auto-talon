import type { ResolvedProviderConfig } from "./config.js";

export function isProviderSwitchable(config: ResolvedProviderConfig): boolean {
  if (config.configured === false) {
    return false;
  }
  if (config.name === "mock" || config.builtinProviderName === "ollama") {
    return true;
  }
  if (config.apiKey !== null && config.apiKey.length > 0) {
    return true;
  }
  if (
    config.builtinProviderName === null &&
    config.baseUrl !== null &&
    config.baseUrl.length > 0
  ) {
    return true;
  }
  return false;
}
