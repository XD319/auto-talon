import {
  isProviderSwitchable,
  resolveProviderConfig,
  type ResolvedProviderConfig
} from "../../providers/index.js";
import type { AuxiliaryProviderResolver } from "../../providers/auxiliary-resolver.js";
import { clearFallbackProviderCache } from "../../providers/provider-failover.js";
import type { ProviderRouter } from "../../providers/routing/provider-router.js";
import type { AuditService } from "../../audit/audit-service.js";
import type { Provider, SessionRecord, TaskRecord, TokenBudget } from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import { resolveRuntimeConfig } from "../runtime-config.js";
import type { ExecutionKernel } from "../execution-kernel.js";
import type { AgentApplicationServiceDependencies } from "../application-service.js";
import type { SessionService } from "../sessions/index.js";
import {
  formatProviderSelection,
  switchProviderRuntime,
  type ProviderSwitchPersistScope,
  type SwitchProviderResult
} from "../operations/provider-switch-service.js";
import {
  createModelSelectionView,
  readSessionModelSelection,
  withSessionModelSelection,
  withoutSessionModelSelection,
  type ModelSelectionView
} from "../operations/model-selection-service.js";

export type ProviderSwitchRuntime = Pick<
  AgentApplicationServiceDependencies,
  | "auxiliaryProviderResolver"
  | "executionKernel"
  | "provider"
  | "providerConfig"
  | "providerRouter"
  | "tokenBudget"
>;

export interface ProviderSwitchFacadeDependencies {
  auditService: AuditService;
  findSession: (sessionId: string) => SessionRecord | null;
  listPendingApprovals: () => { length: number };
  listPendingClarifyPrompts: () => { length: number };
  listTasks: () => TaskRecord[];
  runtime: ProviderSwitchRuntime;
  sessionService: SessionService;
  tokenBudgetInputLimitExplicit: boolean;
  traceService: TraceService;
  workspaceRoot: string;
}

export class ProviderSwitchFacade {
  private switchProviderInFlight: Promise<SwitchProviderResult> | null = null;

  public constructor(private readonly dependencies: ProviderSwitchFacadeDependencies) {}

  public modelSelectionView(sessionId?: string): ModelSelectionView {
    const session = this.resolveOptionalSession(sessionId);
    return createModelSelectionView({
      currentProvider: this.dependencies.runtime.providerConfig,
      cwd: this.dependencies.workspaceRoot,
      runtimeConfig: resolveRuntimeConfig(this.dependencies.workspaceRoot),
      runtimeOverrideActive: this.dependencies.runtime.providerRouter?.hasMainProviderOverride() ?? false,
      session
    });
  }

  public async setSessionModelSelection(input: {
    selection: string;
    sessionId: string;
  }): Promise<{ result: SwitchProviderResult; session: SessionRecord; view: ModelSelectionView }> {
    const session = this.requireSession(input.sessionId);
    const result = await this.switchProvider({
      persist: "session",
      selection: input.selection,
      sessionId: session.sessionId
    });
    return {
      result,
      session: this.requireSession(session.sessionId),
      view: this.modelSelectionView(session.sessionId)
    };
  }

  public async clearSessionModelSelection(
    sessionId: string
  ): Promise<{ result: SwitchProviderResult | null; session: SessionRecord; view: ModelSelectionView }> {
    const session = this.requireSession(sessionId);
    const priorSelection = readSessionModelSelection(session.metadata);
    const updated = this.dependencies.sessionService.updateMetadata(
      session.sessionId,
      withoutSessionModelSelection(session.metadata)
    );

    let result: SwitchProviderResult | null = null;
    const defaultProvider = resolveProviderConfig(this.dependencies.workspaceRoot);
    if (isProviderSwitchable(defaultProvider)) {
      result = await switchProviderRuntime({
        cwd: this.dependencies.workspaceRoot,
        persist: "session",
        selection: formatProviderSelection(defaultProvider),
        tokenBudget: this.dependencies.runtime.tokenBudget,
        tokenBudgetInputLimitExplicit: this.dependencies.tokenBudgetInputLimitExplicit
      });
      this.applyProviderSwitchResult(result, { mainProviderOverride: false });
    } else {
      this.dependencies.runtime.providerRouter?.setMainProvider(null);
    }
    this.recordModelSelectionCleared(session.sessionId, priorSelection?.selection ?? null);

    return {
      result,
      session: updated,
      view: this.modelSelectionView(session.sessionId)
    };
  }

  public async switchProvider(input: {
    persist: ProviderSwitchPersistScope;
    selection: string;
    sessionId?: string;
  }): Promise<SwitchProviderResult> {
    if (this.switchProviderInFlight !== null) {
      throw new Error("Model switch already in progress.");
    }

    const switchTask = this.switchProviderInternal(input);
    this.switchProviderInFlight = switchTask;
    try {
      return await switchTask;
    } finally {
      this.switchProviderInFlight = null;
    }
  }

  private async switchProviderInternal(input: {
    persist: ProviderSwitchPersistScope;
    selection: string;
    sessionId?: string;
  }): Promise<SwitchProviderResult> {
    const runningTasks = this.dependencies.listTasks().filter((task) => task.status === "running");
    if (runningTasks.length > 0) {
      throw new Error("Cannot switch model while a task is running. Use /stop first.");
    }
    if (this.dependencies.listPendingApprovals().length > 0) {
      throw new Error("Cannot switch model while an approval is pending.");
    }
    if (this.dependencies.listPendingClarifyPrompts().length > 0) {
      throw new Error("Cannot switch model while clarification is pending.");
    }

    if (input.persist === "session" && input.sessionId !== undefined) {
      this.requireSession(input.sessionId);
    }

    const previousName = this.dependencies.runtime.providerConfig.name;
    const result = await switchProviderRuntime({
      cwd: this.dependencies.workspaceRoot,
      persist: input.persist,
      selection: input.selection,
      tokenBudget: this.dependencies.runtime.tokenBudget,
      tokenBudgetInputLimitExplicit: this.dependencies.tokenBudgetInputLimitExplicit
    });

    this.applyProviderSwitchResult(result, { mainProviderOverride: true });

    if (input.persist === "session" && input.sessionId !== undefined) {
      const session = this.requireSession(input.sessionId);
      this.dependencies.sessionService.updateMetadata(
        session.sessionId,
        withSessionModelSelection(session.metadata, result.selection)
      );
      this.recordModelSelectionUpdated({
        modelName: result.providerConfig.model,
        providerName: result.providerConfig.name,
        selection: result.selection,
        sessionId: session.sessionId,
        source: "session_user"
      });
    } else if (input.persist === "user" || input.persist === "workspace") {
      this.recordModelSelectionUpdated({
        modelName: result.providerConfig.model,
        providerName: result.providerConfig.name,
        selection: result.selection,
        sessionId: null,
        source: input.persist
      });
    }

    this.dependencies.traceService.record({
      actor: "runtime.application",
      eventType: "route_decision",
      payload: {
        kind: "main",
        mode: this.dependencies.runtime.providerRouter?.getMode() ?? "balanced",
        providerName: result.providerConfig.name,
        reason: `model switched to ${result.selection}`,
        sessionId: input.sessionId ?? null,
        taskId: "runtime",
        tier: null
      },
      stage: "planning",
      summary: `Switched model to ${result.selection}`,
      taskId: "runtime"
    });
    this.dependencies.auditService.record({
      action: "route_decided",
      actor: "runtime.application",
      approvalId: null,
      outcome: "succeeded",
      payload: {
        kind: "main",
        modelName: result.providerConfig.model,
        persist: input.persist,
        previousProviderName: previousName,
        providerName: result.providerConfig.name,
        reason: `model switched to ${result.selection}`,
        selection: result.selection,
        sessionId: input.sessionId ?? null
      },
      summary: `Provider switched to ${result.selection}`,
      taskId: null,
      toolCallId: null
    });

    return result;
  }

  private applyProviderSwitchResult(
    result: SwitchProviderResult,
    options: { mainProviderOverride: boolean }
  ): void {
    const runtime = this.dependencies.runtime;
    runtime.provider = result.provider;
    runtime.providerConfig = result.providerConfig;
    runtime.tokenBudget = result.tokenBudget;
    runtime.executionKernel.setPrimaryProvider(result.provider);
    runtime.providerRouter?.setMainProvider(options.mainProviderOverride ? result.provider : null);
    runtime.providerRouter?.clearProviderCache();
    runtime.auxiliaryProviderResolver?.setMainProvider(result.provider);
    runtime.auxiliaryProviderResolver?.clearProviderCache();
    clearFallbackProviderCache();
  }

  private resolveOptionalSession(sessionId: string | undefined): SessionRecord | null {
    if (sessionId === undefined) {
      return null;
    }
    return this.requireSession(sessionId);
  }

  private requireSession(sessionId: string): SessionRecord {
    const session = this.dependencies.findSession(sessionId);
    if (session === null) {
      throw new Error(`Session ${sessionId} was not found.`);
    }
    return session;
  }

  private recordModelSelectionUpdated(input: {
    modelName: string | null;
    providerName: string;
    selection: string;
    sessionId: string | null;
    source: "session_user" | "user" | "workspace";
  }): void {
    this.dependencies.traceService.record({
      actor: "runtime.application",
      eventType: "model_selection_updated",
      payload: input,
      stage: "control",
      summary: `Model selection updated to ${input.selection}`,
      taskId: input.sessionId === null ? "runtime" : `session:${input.sessionId}`
    });
    this.dependencies.auditService.record({
      action: "model_selection_updated",
      actor: "runtime.application",
      approvalId: null,
      outcome: "succeeded",
      payload: input,
      summary: `Model selection updated to ${input.selection}`,
      taskId: null,
      toolCallId: null
    });
  }

  private recordModelSelectionCleared(sessionId: string, priorSelection: string | null): void {
    const payload = { priorSelection, sessionId };
    this.dependencies.traceService.record({
      actor: "runtime.application",
      eventType: "model_selection_cleared",
      payload,
      stage: "control",
      summary: `Model selection cleared for session ${sessionId}`,
      taskId: `session:${sessionId}`
    });
    this.dependencies.auditService.record({
      action: "model_selection_cleared",
      actor: "runtime.application",
      approvalId: null,
      outcome: "succeeded",
      payload,
      summary: `Model selection cleared for session ${sessionId}`,
      taskId: null,
      toolCallId: null
    });
  }
}
