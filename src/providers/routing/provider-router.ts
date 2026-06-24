import type { AuditService } from "../../audit/audit-service.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { Provider, ProviderTier, RouteKind, RoutingMode } from "../../types/index.js";

import { tierFor } from "./provider-tiers.js";

export interface ProviderRouterConfig {
  mode: RoutingMode;
  providers: {
    cheap?: string | undefined;
    balanced?: string | undefined;
    quality?: string | undefined;
  };
  helpers: {
    summarize?: ProviderTier | null;
    classify?: ProviderTier | null;
    recallRank?: ProviderTier | null;
  };
}

export interface SelectProviderInput {
  kind: RouteKind;
  taskId: string;
  sessionId: string | null;
  mode?: RoutingMode;
}

export interface SelectProviderResult {
  provider: Provider | null;
  providerName: string | null;
  tier: ProviderTier | null;
  modeApplied: RoutingMode;
  reason: string;
}

export interface BudgetDowngradeReader {
  isDowngradeActive(scope: "task" | "session", scopeId: string): boolean;
}

export class ProviderRouter {
  private readonly providers = new Map<string, Provider>();
  private mainProviderOverride: Provider | null = null;
  private mode: RoutingMode;

  public constructor(
    private readonly config: ProviderRouterConfig,
    private readonly providerFactory: (name: string) => Provider,
    private readonly budgetService: BudgetDowngradeReader,
    private readonly traceService: TraceService,
    private readonly auditService: AuditService
  ) {
    this.mode = config.mode;
  }

  public getMode(): RoutingMode {
    return this.mode;
  }

  public setMode(mode: RoutingMode): void {
    this.mode = mode;
  }

  public setMainProvider(provider: Provider | null): void {
    this.mainProviderOverride = provider;
  }

  public clearProviderCache(providerName?: string): void {
    if (providerName === undefined) {
      this.providers.clear();
      return;
    }
    this.providers.delete(providerName);
  }

  public selectProvider(input: SelectProviderInput): SelectProviderResult {
    const modeApplied = input.mode ?? this.mode;
    const softDowngrade =
      this.budgetService.isDowngradeActive("task", input.taskId) ||
      (input.sessionId !== null && this.budgetService.isDowngradeActive("session", input.sessionId));

    if (input.kind === "main") {
      if (softDowngrade) {
        return this.selectRoutedProvider(input, modeApplied, "cheap", "soft budget downgrade");
      }
      if (this.mainProviderOverride !== null) {
        const provider = this.mainProviderOverride;
        return this.recordAndReturn(input, {
          modeApplied,
          provider,
          providerName: provider.name,
          reason: "explicit model switch",
          tier: null
        });
      }
      if (!this.hasConfiguredRoutingProviders()) {
        return this.recordAndReturn(input, {
          modeApplied,
          provider: null,
          providerName: null,
          reason: "no routing providers configured",
          tier: null
        });
      }
      const tier = tierFor(modeApplied);
      return this.selectRoutedProvider(input, modeApplied, tier, `routing mode ${modeApplied}`);
    }

    const tier = this.resolveTier(input.kind, modeApplied, softDowngrade);
    const providerName = tier === null ? null : this.resolveProviderName(tier);
    const provider = providerName === null ? null : this.getOrCreateProvider(providerName);
    const reason =
      input.kind === "summarize" || input.kind === "classify" || input.kind === "recall_rank"
        ? `helper route ${input.kind}`
        : `routing mode ${modeApplied}`;

    return this.recordAndReturn(input, {
      modeApplied,
      provider,
      providerName,
      reason,
      tier
    });
  }

  private hasConfiguredRoutingProviders(): boolean {
    return (
      this.config.providers.cheap !== undefined ||
      this.config.providers.balanced !== undefined ||
      this.config.providers.quality !== undefined
    );
  }

  private selectRoutedProvider(
    input: SelectProviderInput,
    modeApplied: RoutingMode,
    tier: ProviderTier,
    reason: string
  ): SelectProviderResult {
    const providerName = this.resolveProviderName(tier);
    const provider = providerName === null ? null : this.getOrCreateProvider(providerName);
    return this.recordAndReturn(input, {
      modeApplied,
      provider,
      providerName,
      reason,
      tier
    });
  }

  private recordAndReturn(
    input: SelectProviderInput,
    result: SelectProviderResult
  ): SelectProviderResult {
    this.traceService.record({
      actor: "runtime.router",
      eventType: "route_decision",
      payload: {
        kind: input.kind,
        mode: result.modeApplied,
        providerName: result.providerName,
        reason: result.reason,
        taskId: input.taskId,
        sessionId: input.sessionId,
        tier: result.tier
      },
      stage: "planning",
      summary: `Route ${input.kind} to ${result.providerName ?? "none"}`,
      taskId: input.taskId
    });
    this.auditService.record({
      action: "route_decided",
      actor: "runtime.router",
      approvalId: null,
      outcome: "succeeded",
      payload: {
        kind: input.kind,
        mode: result.modeApplied,
        providerName: result.providerName,
        reason: result.reason,
        taskId: input.taskId,
        sessionId: input.sessionId,
        tier: result.tier
      },
      summary: `Route decision for ${input.kind}`,
      taskId: input.taskId,
      toolCallId: null
    });
    return result;
  }

  private resolveTier(kind: RouteKind, mode: RoutingMode, downgrade: boolean): ProviderTier | null {
    if (kind === "main") {
      return downgrade ? "cheap" : tierFor(mode);
    }
    if (kind === "summarize") {
      return this.config.helpers.summarize ?? "cheap";
    }
    if (kind === "classify") {
      return this.config.helpers.classify ?? null;
    }
    return this.config.helpers.recallRank ?? null;
  }

  private resolveProviderName(tier: ProviderTier): string | null {
    if (tier === "cheap") {
      return this.config.providers.cheap ?? this.config.providers.balanced ?? null;
    }
    if (tier === "quality") {
      return this.config.providers.quality ?? this.config.providers.balanced ?? null;
    }
    return (
      this.config.providers.balanced ??
      this.config.providers.quality ??
      this.config.providers.cheap ??
      null
    );
  }

  private getOrCreateProvider(name: string): Provider {
    const existing = this.providers.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const provider = this.providerFactory(name);
    this.providers.set(name, provider);
    return provider;
  }
}
