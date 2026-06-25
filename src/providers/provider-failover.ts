import type { AuditService } from "../audit/audit-service.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { JsonObject, Provider, ProviderRequest, ProviderResponse } from "../types/index.js";
import { ProviderError } from "./provider-error.js";
import * as providerConfig from "./config.js";
import * as providerFactory from "./provider-factory.js";
import { isProviderSwitchable } from "./provider-switchable.js";

const FAILOVER_CATEGORIES = new Set([
  "auth_error",
  "rate_limit",
  "provider_unavailable",
  "timeout_error",
  "transient_network_error"
]);

interface ProviderCandidate {
  credentialId: string | null;
  provider: Provider;
  reason: "credential_rotation" | "fallback_chain" | "primary";
  selection: string;
}

export interface ModelFallbackStatus extends JsonObject {
  activeFallback: {
    fromProvider: string;
    providerName: string;
    reason: string;
    selection: string;
  } | null;
  lastFailure: {
    errorCategory: string;
    modelName: string | null;
    providerName: string;
    slot: string;
    taskId: string;
  } | null;
  updatedAt: string | null;
}

const fallbackProviderCache = new Map<string, ProviderCandidate[]>();
let fallbackStatus: ModelFallbackStatus = {
  activeFallback: null,
  lastFailure: null,
  updatedAt: null
};

export interface ProviderFailoverContext {
  auditService?: AuditService;
  auxiliarySlot?: string;
  cwd: string;
  enableFailover: boolean;
  primaryProvider: Provider;
  taskId: string;
  traceService?: TraceService;
}

export function getModelFallbackStatus(): ModelFallbackStatus {
  return {
    activeFallback:
      fallbackStatus.activeFallback === null ? null : { ...fallbackStatus.activeFallback },
    lastFailure: fallbackStatus.lastFailure === null ? null : { ...fallbackStatus.lastFailure },
    updatedAt: fallbackStatus.updatedAt
  };
}

function isFailoverEligible(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return FAILOVER_CATEGORIES.has(error.category);
  }
  return false;
}

function resolveFallbackCandidates(context: ProviderFailoverContext): ProviderCandidate[] {
  const slot = context.auxiliarySlot ?? "main";
  const cacheKey = [
    context.cwd,
    context.primaryProvider.name,
    context.primaryProvider.model ?? "",
    slot
  ].join("\0");
  const cached = fallbackProviderCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const primarySelection = formatProviderSelection(context.primaryProvider);
  const candidates: ProviderCandidate[] = [];
  const seen = new Set([`${context.primaryProvider.name}\0${context.primaryProvider.model ?? ""}\0primary`]);

  try {
    for (const config of providerConfig.resolveProviderCredentialConfigs(context.cwd, primarySelection)) {
      if (!isProviderSwitchable(config)) {
        continue;
      }
      const credentialId = config.credential.activeCredentialId;
      const key = `${config.name}\0${config.model ?? ""}\0${credentialId ?? ""}`;
      if (credentialId === null || seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        credentialId,
        provider: providerFactory.createProvider(config),
        reason: "credential_rotation",
        selection: primarySelection
      });
    }
  } catch {
    // Runtime-injected providers may not exist in provider.config.json. They can still use
    // configured fallback providers; only credential rotation is unavailable.
  }

  const fallbackSelections = context.auxiliarySlot === undefined
    ? providerConfig.resolveMergedFallbackProviders(context.cwd)
    : providerConfig.resolveMergedFallbackProvidersForSlot(context.cwd, slot);
  for (const selection of fallbackSelections) {
    const resolvedSelection = providerConfig.resolveProviderSelectionWithAliases(selection, context.cwd);
    try {
      const config = providerConfig.resolveProviderConfigForProvider(context.cwd, resolvedSelection);
      if (!isProviderSwitchable(config)) {
        continue;
      }
      const credentialId = (config as { credential?: typeof config.credential }).credential?.activeCredentialId ?? null;
      const key = `${config.name}\0${config.model ?? ""}\0${credentialId ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        credentialId,
        provider: providerFactory.createProvider(config),
        reason: "fallback_chain",
        selection: resolvedSelection
      });
    } catch {
      continue;
    }
  }

  fallbackProviderCache.set(cacheKey, candidates);
  return candidates;
}

export function clearFallbackProviderCache(): void {
  fallbackProviderCache.clear();
  fallbackStatus = {
    activeFallback: null,
    lastFailure: null,
    updatedAt: null
  };
}

export async function generateWithProviderFailover(
  context: ProviderFailoverContext,
  input: ProviderRequest
): Promise<ProviderResponse> {
  const candidates: ProviderCandidate[] = [
    {
      credentialId: null,
      provider: context.primaryProvider,
      reason: "primary",
      selection: formatProviderSelection(context.primaryProvider)
    }
  ];
  if (context.enableFailover) {
    candidates.push(...resolveFallbackCandidates(context));
  }

  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    try {
      const response = await candidate.provider.generate(input);
      if (index > 0) {
        recordFallbackSucceeded(context, candidates[0]!.provider, candidate);
      }
      return withProviderMetadata(response, candidate.provider);
    } catch (error) {
      lastError = error;
      const hasNext = index < candidates.length - 1;
      recordProviderFailure(context, candidate.provider, error);
      if (!hasNext || !isFailoverEligible(error)) {
        if (index > 0 || candidates.length > 1) {
          recordFallbackExhausted(context, candidate.provider, error);
        }
        throw error;
      }
      recordFallbackStarted(context, candidate.provider, candidates[index + 1]!, error, index + 1, candidates.length - 1);
    }
  }

  throw lastError;
}

function recordFallbackStarted(
  context: ProviderFailoverContext,
  failedProvider: Provider,
  nextCandidate: ProviderCandidate,
  error: unknown,
  attempt: number,
  maxRetries: number
): void {
  const errorCategory = error instanceof ProviderError ? error.category : "unknown_error";
  const slot = context.auxiliarySlot ?? "main";
  const now = new Date().toISOString();
  fallbackStatus = {
    activeFallback: {
      fromProvider: failedProvider.name,
      providerName: nextCandidate.provider.name,
      reason: nextCandidate.reason,
      selection: nextCandidate.selection
    },
    lastFailure: {
      errorCategory,
      modelName: failedProvider.model ?? null,
      providerName: failedProvider.name,
      slot,
      taskId: context.taskId
    },
    updatedAt: now
  };
  context.traceService?.record({
    actor: `provider.${failedProvider.name}`,
    eventType: "provider_retry_scheduled",
    payload: {
      attempt,
      delayMs: 0,
      errorCategory,
      iteration: 0,
      maxRetries,
      modelName: failedProvider.model ?? null,
      providerName: failedProvider.name
    },
    stage: "planning",
    summary: `Provider failover trying ${nextCandidate.provider.name} after ${failedProvider.name}`,
    taskId: context.taskId
  });
  context.traceService?.record({
    actor: "provider.failover",
    eventType: "model_fallback_started",
    payload: {
      credentialId: nextCandidate.credentialId,
      errorCategory,
      fromProvider: failedProvider.name,
      reason: nextCandidate.reason,
      selection: nextCandidate.selection,
      slot,
      toProvider: nextCandidate.provider.name
    },
    stage: "planning",
    summary: `Model fallback started for ${slot}`,
    taskId: context.taskId
  });
  context.auditService?.record({
    action: "model_fallback_started",
    actor: "provider.failover",
    approvalId: null,
    outcome: "attempted",
    payload: {
      credentialId: nextCandidate.credentialId,
      errorCategory,
      fromProvider: failedProvider.name,
      reason: nextCandidate.reason,
      selection: nextCandidate.selection,
      slot,
      toProvider: nextCandidate.provider.name
    },
    summary: `Model fallback started for ${slot}`,
    taskId: context.taskId,
    toolCallId: null
  });
  if (nextCandidate.reason === "credential_rotation") {
    context.traceService?.record({
      actor: "provider.failover",
      eventType: "credential_rotated",
      payload: {
        credentialId: nextCandidate.credentialId,
        providerName: nextCandidate.provider.name,
        slot
      },
      stage: "planning",
      summary: `Credential rotated for ${nextCandidate.provider.name}`,
      taskId: context.taskId
    });
  }
}

function recordFallbackSucceeded(
  context: ProviderFailoverContext,
  primaryProvider: Provider,
  candidate: ProviderCandidate
): void {
  const slot = context.auxiliarySlot ?? "main";
  fallbackStatus = {
    ...fallbackStatus,
    activeFallback: {
      fromProvider: primaryProvider.name,
      providerName: candidate.provider.name,
      reason: candidate.reason,
      selection: candidate.selection
    },
    updatedAt: new Date().toISOString()
  };
  context.traceService?.record({
    actor: "provider.failover",
    eventType: "model_fallback_succeeded",
    payload: {
      credentialId: candidate.credentialId,
      fromProvider: primaryProvider.name,
      reason: candidate.reason,
      selection: candidate.selection,
      slot,
      toProvider: candidate.provider.name
    },
    stage: "planning",
    summary: `Model fallback succeeded for ${slot}`,
    taskId: context.taskId
  });
  context.auditService?.record({
    action: "model_fallback_succeeded",
    actor: "provider.failover",
    approvalId: null,
    outcome: "succeeded",
    payload: {
      credentialId: candidate.credentialId,
      fromProvider: primaryProvider.name,
      reason: candidate.reason,
      selection: candidate.selection,
      slot,
      toProvider: candidate.provider.name
    },
    summary: `Model fallback succeeded for ${slot}`,
    taskId: context.taskId,
    toolCallId: null
  });
}

function recordFallbackExhausted(
  context: ProviderFailoverContext,
  provider: Provider,
  error: unknown
): void {
  const slot = context.auxiliarySlot ?? "main";
  const errorCategory = error instanceof ProviderError ? error.category : "unknown_error";
  fallbackStatus = {
    activeFallback: null,
    lastFailure: {
      errorCategory,
      modelName: provider.model ?? null,
      providerName: provider.name,
      slot,
      taskId: context.taskId
    },
    updatedAt: new Date().toISOString()
  };
  context.traceService?.record({
    actor: "provider.failover",
    eventType: "model_fallback_exhausted",
    payload: {
      errorCategory,
      providerName: provider.name,
      slot
    },
    stage: "planning",
    summary: `Model fallback exhausted for ${slot}`,
    taskId: context.taskId
  });
  context.auditService?.record({
    action: "model_fallback_exhausted",
    actor: "provider.failover",
    approvalId: null,
    outcome: "failed",
    payload: {
      errorCategory,
      providerName: provider.name,
      slot
    },
    summary: `Model fallback exhausted for ${slot}`,
    taskId: context.taskId,
    toolCallId: null
  });
}

function recordProviderFailure(
  context: ProviderFailoverContext,
  provider: Provider,
  error: unknown
): void {
  const errorCategory = error instanceof ProviderError ? error.category : "unknown_error";
  fallbackStatus = {
    ...fallbackStatus,
    lastFailure: {
      errorCategory,
      modelName: provider.model ?? null,
      providerName: provider.name,
      slot: context.auxiliarySlot ?? "main",
      taskId: context.taskId
    },
    updatedAt: new Date().toISOString()
  };
}

function withProviderMetadata(response: ProviderResponse, provider: Provider): ProviderResponse {
  const modelName = response.metadata?.modelName ?? provider.model;
  return {
    ...response,
    metadata: {
      ...(response.metadata ?? {}),
      ...(modelName !== undefined ? { modelName } : {}),
      providerName: response.metadata?.providerName ?? provider.name
    }
  };
}

function formatProviderSelection(provider: Provider): string {
  return provider.model === undefined || provider.model.length === 0
    ? provider.name
    : `${provider.name}:${provider.model}`;
}