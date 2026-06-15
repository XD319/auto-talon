import type { ProviderUsage } from "../types/index.js";
import { contextWindowPercentFromPrompt } from "../runtime/context/token-counter.js";

/** Rough placeholder pricing (USD per 1M tokens) for status estimates; override with env if needed. */
export function estimateSessionCostUsd(
  providerName: string,
  modelName: string | undefined,
  usage: ProviderUsage
): number {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const key = `${providerName}:${modelName ?? ""}`.toLowerCase();

  let inPerM = 3;
  let outPerM = 15;

  if (key.includes("gpt-4o-mini")) {
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
  }

  const custom = process.env.AGENT_TOKEN_PRICE_IN_PER_M;
  const customOut = process.env.AGENT_TOKEN_PRICE_OUT_PER_M;
  if (custom !== undefined && customOut !== undefined) {
    inPerM = Number(custom);
    outPerM = Number(customOut);
  }

  return (input * inPerM + output * outPerM) / 1_000_000;
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
    parts.push(`~$${estimatedCostUsd.toFixed(3)}`);
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
