import type { ProviderUsage } from "../types/index.js";
import { contextWindowPercentFromPrompt } from "../runtime/context/token-counter.js";

export interface TokenPricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Rough placeholder pricing (USD per 1M tokens) for status estimates; override with env or runtime config. */
export function estimateSessionCostUsd(
  providerName: string,
  modelName: string | undefined,
  usage: ProviderUsage,
  pricing?: Record<string, TokenPricingEntry>
): number {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const key = `${providerName}:${modelName ?? ""}`.toLowerCase();

  const configured = resolveConfiguredPricing(pricing, providerName, modelName);
  if (configured !== null) {
    return (input * configured.inputPerMillion + output * configured.outputPerMillion) / 1_000_000;
  }

  let inPerM = 3;
  let outPerM = 15;

  if (providerName === "mock" || providerName === "ollama") {
    inPerM = 0;
    outPerM = 0;
  } else if (key.includes("gpt-4o-mini")) {
    inPerM = 0.15;
    outPerM = 0.6;
  } else if (key.includes("gpt-4o")) {
    inPerM = 2.5;
    outPerM = 10;
  } else if (key.includes("haiku") || key.includes("3-5-haiku")) {
    inPerM = 0.25;
    outPerM = 1.25;
  } else if (key.includes("sonnet") || key.includes("3-5-sonnet")) {
    inPerM = 3;
    outPerM = 15;
  } else if (key.includes("opus")) {
    inPerM = 15;
    outPerM = 75;
  } else if (providerName === "gemini" || key.includes("gemini")) {
    inPerM = 0.15;
    outPerM = 0.6;
  } else if (providerName === "glm" || key.includes("glm")) {
    inPerM = 0.1;
    outPerM = 0.1;
  } else if (providerName === "moonshot" || key.includes("kimi")) {
    inPerM = 0.15;
    outPerM = 2.5;
  } else if (providerName === "qwen" || key.includes("qwen")) {
    inPerM = 0.4;
    outPerM = 1.2;
  } else if (providerName === "xai" || key.includes("grok")) {
    inPerM = 2;
    outPerM = 10;
  } else if (providerName === "minimax" || key.includes("minimax")) {
    inPerM = 0.3;
    outPerM = 1.1;
  } else if (providerName === "xfyun-coding" || key.includes("astron")) {
    inPerM = 0.5;
    outPerM = 1.5;
  } else if (providerName === "openrouter") {
    inPerM = 0.15;
    outPerM = 0.6;
  }

  const custom = process.env.AGENT_TOKEN_PRICE_IN_PER_M;
  const customOut = process.env.AGENT_TOKEN_PRICE_OUT_PER_M;
  if (custom !== undefined && customOut !== undefined) {
    inPerM = Number(custom);
    outPerM = Number(customOut);
  }

  return (input * inPerM + output * outPerM) / 1_000_000;
}

function resolveConfiguredPricing(
  pricing: Record<string, TokenPricingEntry> | undefined,
  providerName: string,
  modelName: string | undefined
): TokenPricingEntry | null {
  if (pricing === undefined) {
    return null;
  }

  const candidates = [
    modelName ?? "",
    `${providerName}:${modelName ?? ""}`,
    providerName
  ].filter((candidate) => candidate.length > 0);

  for (const candidate of candidates) {
    const entry = pricing[candidate];
    if (entry !== undefined) {
      return entry;
    }
  }

  return null;
}

export function contextWindowPercent(
  usage: ProviderUsage,
  inputLimit: number,
  _outputLimit: number,
  reservedOutput = 0
): number {
  return contextWindowPercentFromPrompt(usage.inputTokens, inputLimit, reservedOutput);
}

export function formatCompactTokenMetric(
  inputTokens: number,
  inputLimit: number,
  reservedOutput: number,
  estimatedCostUsd: number
): string | null {
  const parts: string[] = [];
  const usableWindow = Math.max(inputLimit - reservedOutput, 1);
  if (inputTokens > 0) {
    parts.push(`${compactTokenCount(inputTokens)}/${compactTokenCount(usableWindow)}`);
  }
  if (estimatedCostUsd >= 0.0001) {
    parts.push(`~$${estimatedCostUsd.toFixed(3)} est.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function compactTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return String(value);
}
