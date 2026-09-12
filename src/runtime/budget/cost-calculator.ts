import { resolveProviderManifest } from "../../providers/provider-registry.js";
import type { BudgetPricingEntry, ProviderUsage } from "../../types/index.js";

export type CachedInputAccounting = "inclusive" | "exclusive";

export function cachedInputAccountingForProvider(providerName: string): CachedInputAccounting {
  const manifest = resolveProviderManifest(providerName);
  return manifest?.transport === "anthropic-compatible" ? "exclusive" : "inclusive";
}

export function computeCostUsd(
  usage: ProviderUsage,
  pricing: BudgetPricingEntry | null | undefined,
  cachedInputAccounting: CachedInputAccounting = "exclusive"
): number | null {
  if (pricing === null || pricing === undefined) {
    return null;
  }
  const cachedTokens = usage.cachedInputTokens;
  const cachedRate = pricing.cachedInputPerMillion;
  const priceCached =
    cachedRate !== undefined && cachedTokens !== undefined;
  const billedInputTokens =
    priceCached && cachedInputAccounting === "inclusive"
      ? Math.max(0, usage.inputTokens - cachedTokens)
      : usage.inputTokens;
  const input = (billedInputTokens / 1_000_000) * pricing.inputPerMillion;
  const output = (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cachedInput = priceCached ? (cachedTokens / 1_000_000) * cachedRate : 0;
  const total = input + output + cachedInput;
  return Number.isFinite(total) ? Number(total.toFixed(8)) : null;
}
