import type { Provider, ProviderRequest, ProviderResponse } from "../types/index.js";
import { ProviderError } from "./provider-error.js";
import {
  resolveMergedFallbackProviders,
  resolveProviderConfigForProvider,
  resolveProviderSelectionWithAliases
} from "./config.js";
import { createProvider } from "./provider-factory.js";
import { isProviderSwitchable } from "./provider-switchable.js";
import type { TraceService } from "../tracing/trace-service.js";

const FAILOVER_CATEGORIES = new Set([
  "auth_error",
  "rate_limit",
  "server_error",
  "timeout_error",
  "transport_error"
]);

const fallbackProviderCache = new Map<string, Provider[]>();

export interface ProviderFailoverContext {
  cwd: string;
  enableFailover: boolean;
  primaryProvider: Provider;
  taskId: string;
  traceService?: TraceService;
}

function isFailoverEligible(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return FAILOVER_CATEGORIES.has(error.category);
  }
  return false;
}

function resolveFallbackCandidates(cwd: string, primaryProvider: Provider): Provider[] {
  const cacheKey = `${cwd}\0${primaryProvider.name}\0${primaryProvider.model ?? ""}`;
  const cached = fallbackProviderCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const candidates: Provider[] = [];
  for (const selection of resolveMergedFallbackProviders(cwd)) {
    const resolvedSelection = resolveProviderSelectionWithAliases(selection, cwd);
    const config = resolveProviderConfigForProvider(cwd, resolvedSelection);
    if (!isProviderSwitchable(config)) {
      continue;
    }
    if (config.name === primaryProvider.name) {
      continue;
    }
    candidates.push(createProvider(config));
  }

  fallbackProviderCache.set(cacheKey, candidates);
  return candidates;
}

export function clearFallbackProviderCache(): void {
  fallbackProviderCache.clear();
}

export async function generateWithProviderFailover(
  context: ProviderFailoverContext,
  input: ProviderRequest
): Promise<ProviderResponse> {
  const candidates: Provider[] = [context.primaryProvider];
  if (context.enableFailover) {
    candidates.push(...resolveFallbackCandidates(context.cwd, context.primaryProvider));
  }

  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const provider = candidates[index]!;
    try {
      const response = await provider.generate(input);
      return response;
    } catch (error) {
      lastError = error;
      const hasNext = index < candidates.length - 1;
      if (!hasNext || !isFailoverEligible(error)) {
        throw error;
      }
      context.traceService?.record({
        actor: `provider.${provider.name}`,
        eventType: "provider_retry_scheduled",
        payload: {
          attempt: index + 1,
          delayMs: 0,
          errorCategory:
            error instanceof ProviderError ? error.category : "server_error",
          iteration: input.iteration,
          maxRetries: candidates.length - 1,
          modelName: provider.model ?? null,
          providerName: provider.name
        },
        stage: "planning",
        summary: `Provider failover trying next candidate after ${provider.name}`,
        taskId: context.taskId
      });
    }
  }

  throw lastError;
}
