import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { createManagedAbortController, throwIfAborted } from "./abort-controller.js";
import { AppError, toAppError } from "./app-error.js";
import {
  buildFilteredContextDebugFragments,
  ExecutionContextAssembler
} from "./context-assembler.js";
import {
  buildFinalSessionCompactInput,
  buildReviewerTracePayload,
  createToolFeedbackMessage,
  emitTaskEvent,
  findLastAssistantToolCallsResponse,
  injectResumeContextMessages,
  safeSerializeToolOutputForBudget,
  normalizeProviderFailure,
  providerUsageToJson,
  readSessionResumeMemoryContext,
  readSessionResumeMessages,
  readSessionResumePriorTaskId,
  rebuildTurnProviderMessages,
  sanitizeToolCallPairing,
  sleepWithAbort,
  summarizeText,
  summarizeToolOutput,
  toConversationRole,
  toolCallSignature
} from "./kernel-support.js";
import {
  BudgetRecorder,
  CheckpointManager,
  CompletionController,
  isSuccessfulVerificationToolCall as isSuccessfulVerificationToolExecution
} from "./kernel/index.js";
import { buildRepoMap } from "./repo-map.js";
import { tokenBudgetToJson } from "./serialization.js";
import {
  RecentFileReadCache,
  formatRecentlyReadFilesSummary,
  recordRecentFileReadFromToolCall,
  syncPinnedRecentFilesMessage
} from "./context/recent-file-reads.js";
import type { ContextRetentionConfig } from "./context/recent-file-reads.js";
import {
  resolveTodoSessionKeyFromTaskMetadata,
  syncSessionTodosMessage
} from "./context/session-todos.js";
import { PRIOR_TASK_RESULT_SOURCE_TYPE } from "./sessions/prior-task-context.js";
import type { ContextCompactor, SessionSummaryService } from "./context/index.js";
import {
  computeCompactThreshold,
  computePromptTokens,
  createHybridTokenCounterState,
  recordApiUsage,
  type HybridTokenCounterState
} from "./context/token-counter.js";
import { applyToolOutputBudget } from "./context/tool-output-budget.js";
import { buildSessionHandoffMessageContent, listDiscardedMessages } from "./context/compact-handoff.js";
import type { ManualCompactRequest } from "./context/manual-compact-coordinator.js";
import {
  dropOldestNonSystemMessages,
  isContextOverflowProviderError
} from "./context/reactive-compact.js";
import { pruneOldToolResults } from "./context/tool-result-pruner.js";
import { selectTailMessages } from "./context/tail-selector.js";
import type { RecallPlanner } from "./retrieval/index.js";
import type { RetrievalWorker, SummarizerWorker, WorkerDispatcher } from "./workers/index.js";
import type { RuntimeConfig, WorkflowRuntimeConfig } from "./runtime-config.js";
import type { ToolExposurePlanner, ToolExposurePlannerInput } from "./tool-exposure-planner.js";
import type { ProviderRouter } from "../providers/routing/provider-router.js";
import type { AuxiliaryProviderResolver } from "../providers/auxiliary-resolver.js";
import type { ProviderError } from "../providers/provider-error.js";
import { generateWithProviderFailover } from "../providers/provider-failover.js";
import type { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import type { AuditService } from "../audit/audit-service.js";
import type {
  ConversationMessage,
  ContextAssemblyDebugView,
  ContextFragment,
  ExecutionCheckpointRepository,
  MemoryRecallResult,
  Provider,
  ProviderResponse,
  ProviderToolDescriptor,
  ProviderRetryNotice,
  ProviderStatusNotice,
  ProviderToolCall,
  RuntimeOutputEvent,
  RuntimeTaskEvent,
  RunMetadataRepository,
  RuntimeRunOptions,
  RuntimeRunResult,
  SessionCompactResult,
  SessionTranscriptRepository,
  TaskRecord,
  TaskRepository,
  SessionCommitmentState,
  SessionLineageRepository,
  SessionTaskRepository,
  SessionEntrySource,
  ToolExecutionResult,
  TokenBudget,
  BudgetPricingEntry,
  JsonValue
} from "../types/index.js";
import type { MemoryPlane } from "../memory/memory-plane.js";
import { buildCapabilityDeclaration } from "../memory/capability-declaration-builder.js";
import {
  DeterministicCompactSummarizer,
  type CompactSummarizer,
  ProviderSubagentSummarizer
} from "../memory/compact-summarizer.js";
import type { CompactTriggerPolicy } from "../memory/compact-policy.js";
import type { ToolOrchestrator, ToolExecutionOutcome } from "../tools/index.js";
import { buildParallelSafeLookup } from "../tools/tool-parallel-policy.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { BudgetService } from "./budget/budget-service.js";
import type { RuntimeOutputService } from "./runtime-output-service.js";
import type { SessionMessageProjector } from "./sessions/session-message-projector.js";
import type { SkillContextService } from "../skills/index.js";
import type { ManualCompactCoordinator } from "./context/manual-compact-coordinator.js";
import type { TodoSessionStore } from "../tools/todo-session-store.js";

export interface ExecutionKernelDependencies {
  agentProfileRegistry: AgentProfileRegistry;
  auditService: AuditService;
  auxiliaryProviderResolver?: AuxiliaryProviderResolver;
  compactPolicy: CompactTriggerPolicy;
  executionCheckpointRepository: ExecutionCheckpointRepository;
  getSessionCommitmentState?: (sessionId: string) => SessionCommitmentState | null;
  manualCompactCoordinator?: ManualCompactCoordinator;
  memoryPlane: MemoryPlane;
  recallPlanner: RecallPlanner;
  provider: Provider;
  runMetadataRepository: RunMetadataRepository;
  runtimeVersion: string;
  taskRepository: TaskRepository;
  sessionTaskRepository: SessionTaskRepository;
  sessionLineageRepository: SessionLineageRepository;
  sessionTranscriptRepository: SessionTranscriptRepository;
  sessionMessageProjector?: SessionMessageProjector;
  contextCompactor: ContextCompactor;
  sessionSummaryService: SessionSummaryService;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  outputService: RuntimeOutputService;
  workflow: WorkflowRuntimeConfig;
  compact: RuntimeConfig["compact"];
  contextRetention?: ContextRetentionConfig;
  budgetPricing?: Record<string, BudgetPricingEntry>;
  budgetService?: BudgetService;
  workerDispatcher?: WorkerDispatcher;
  summarizerWorker?: SummarizerWorker;
  retrievalWorker?: RetrievalWorker;
  providerRouter?: ProviderRouter;
  routingMode?: "cheap_first" | "balanced" | "quality_first";
  toolExposurePlanner?: ToolExposurePlanner;
  skillContextService?: SkillContextService;
  todoSessionStore?: TodoSessionStore;
  workspaceRoot: string;
}

interface ExecutionLoopState {
  compactedCount: number;
  costWarnedToolNames: string[];
  cumulativeToolCallCount: number;
  cwd: string;
  managedAbortController: ReturnType<typeof createManagedAbortController>;
  maxIterations: number;
  microPrunedCount: number;
  memoryContext: ContextFragment[];
  memoryRecall: MemoryRecallResult | null;
  messages: ConversationMessage[];
  /** Present only when the CLI/TUI requests streamed assistant text. */
  onAssistantTextDelta?: (delta: string) => void;
  onOutputEvent?: (event: RuntimeOutputEvent) => void;
  onTaskEvent?: (event: RuntimeTaskEvent) => void;
  pendingToolCalls: ProviderToolCall[];
  completionIntentSeenAt: number | null;
  completionVerificationGuardEmitted: boolean;
  completionVerificationSatisfied: boolean;
  completionVerificationSatisfiedEmitted: boolean;
  criticalBudgetPressureEmitted: boolean;
  intentFulfillmentGuardEmitted: boolean;
  interactionMode?: RuntimeRunOptions["interactionMode"];
  postCompletionVerificationReads: number;
  selectedSkillContext: ContextFragment[];
  silentToolTurns: number;
  toolCallSignatures: Map<
    string,
    { iteration: number; toolCallId: string; cachedToolOutput?: string }
  >;
  turnFilteredFragments: ContextAssemblyDebugView["filteredOutFragments"];
  turnProviderMessages: ConversationMessage[];
  recentFileReadCache: RecentFileReadCache | null;
  repoMapSummary?: string;
  task: TaskRecord;
  tokenBudget: TokenBudget;
  tokenCounter: HybridTokenCounterState;
  toolArtifactsRoot: string;
  warningBudgetPressureEmitted: boolean;
  writeToolSucceeded: boolean;
}

export class ExecutionKernel {
  private readonly contextAssembler = new ExecutionContextAssembler();
  private readonly budgetRecorder: BudgetRecorder;
  private readonly checkpointManager: CheckpointManager;
  private readonly completionController: CompletionController;

  public constructor(private readonly dependencies: ExecutionKernelDependencies) {
    this.budgetRecorder = new BudgetRecorder({
      mode: dependencies.routingMode ?? "balanced",
      recordTrace: (event) => dependencies.traceService.record(event),
      taskRepository: dependencies.taskRepository,
      ...(dependencies.budgetPricing !== undefined
        ? { budgetPricing: dependencies.budgetPricing }
        : {}),
      ...(dependencies.budgetService !== undefined
        ? { budgetService: dependencies.budgetService }
        : {})
    });
    this.checkpointManager = new CheckpointManager({
      executionCheckpointRepository: dependencies.executionCheckpointRepository,
      toolOrchestrator: dependencies.toolOrchestrator
    });
    this.completionController = new CompletionController({
      describeTool: (toolName) => dependencies.toolOrchestrator.describeTool(toolName),
      recordTrace: (event) => dependencies.traceService.record(event),
      testCommands: formatWorkflowTestCommandHints(dependencies.workflow.testCommands)
    });
  }

  public setPrimaryProvider(provider: Provider): void {
    this.dependencies.provider = provider;
  }

  private resolveActiveMainProvider(task: TaskRecord): Provider {
    const routed = this.dependencies.providerRouter?.selectProvider({
      kind: "main",
      taskId: task.taskId,
      sessionId: task.sessionId ?? null,
      ...(this.dependencies.routingMode !== undefined
        ? { mode: this.dependencies.routingMode }
        : {})
    });
    return routed?.provider ?? this.dependencies.provider;
  }

  private syncSessionTodosContext(input: {
    iteration?: number;
    messages: ConversationMessage[];
    task: TaskRecord;
  }): { todoCount: number } | null {
    const store = this.dependencies.todoSessionStore;
    if (store === undefined) {
      return null;
    }
    const sessionKey = resolveTodoSessionKeyFromTaskMetadata({
      ...(input.task.sessionId !== undefined ? { sessionId: input.task.sessionId } : {}),
      taskId: input.task.taskId,
      taskMetadata: input.task.metadata
    });
    const injected = syncSessionTodosMessage(input.messages, store, sessionKey);
    if (injected === null) {
      return null;
    }
    const todoCount = store.get(sessionKey).length;
    return { todoCount };
  }

  private async planRecall(
    input: Parameters<RecallPlanner["plan"]>[0]
  ): Promise<ReturnType<RecallPlanner["plan"]>> {
    const workerDispatcher = this.dependencies.workerDispatcher;
    const retrievalWorker = this.dependencies.retrievalWorker;
    if (workerDispatcher === undefined || retrievalWorker === undefined) {
      return this.dependencies.recallPlanner.plan(input);
    }
    const result = await workerDispatcher.dispatch(
      {
        backoffBaseMs: 150,
        backoffMaxMs: 1_000,
        input,
        maxAttempts: 2,
        taskId: input.task.taskId,
        sessionId: input.task.sessionId ?? null,
        timeoutMs: 5_000,
        workerId: randomUUID(),
        workerKind: "retrieval"
      },
      (request) => retrievalWorker.execute(request)
    );
    if (result.output !== null) {
      return result.output;
    }
    return this.dependencies.recallPlanner.plan(input);
  }

  public async run(options: RuntimeRunOptions): Promise<RuntimeRunResult> {
    const taskId = options.taskId ?? randomUUID();
    const explicitSkillMetadata = this.buildExplicitSkillMetadata(options.taskInput);
    const taskMetadata = {
      ...(options.metadata ?? {}),
      ...explicitSkillMetadata,
      ...(options.interactionMode !== undefined ? { interactionMode: options.interactionMode } : {})
    };
    let task = this.dependencies.taskRepository.create({
      agentProfileId: options.agentProfileId,
      cwd: options.cwd,
      input: options.taskInput,
      maxIterations: options.maxIterations,
      metadata: taskMetadata,
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      taskId,
      sessionId: options.sessionId ?? null,
      tokenBudget: options.tokenBudget
    });
    const stopOutputSubscription =
      options.onOutputEvent === undefined
        ? null
        : this.dependencies.outputService.subscribe((event) => {
            if (event.taskId === taskId) {
              options.onOutputEvent?.(event);
            }
          });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_created",
      payload: {
        agentProfileId: options.agentProfileId,
        cwd: options.cwd,
        input: options.taskInput,
        providerName: this.dependencies.provider.name,
        requesterUserId: options.userId
      },
      stage: "lifecycle",
      summary: "Task persisted",
      taskId
    });
    this.emitOutput({
      eventType: "task_input",
      payload: { input: options.taskInput },
      stage: "planning",
      taskId
    });
    this.appendSessionTranscript(task, {
      content: options.taskInput,
      eventType: "user_message",
      payload: {
        source: "task_input"
      },
      role: "user"
    });

    this.dependencies.runMetadataRepository.create({
      agentProfileId: options.agentProfileId,
      createdAt: new Date().toISOString(),
      metadata: taskMetadata,
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      runMetadataId: randomUUID(),
      runtimeVersion: this.dependencies.runtimeVersion,
      taskId,
      timeoutMs: options.timeoutMs,
      tokenBudget: options.tokenBudget,
      workspaceRoot: this.dependencies.workspaceRoot
    });

    const timeoutMode = options.timeoutMode ?? "wall_clock";
    const managedAbortController = createManagedAbortController(options.timeoutMs, options.signal, {
      mode: timeoutMode,
      onInactivityWarning: (details) => {
        this.emitOutput({
          eventType: "provider_status",
          payload: {
            kind: "inactivity_warning",
            message: "Task has been inactive for 75% of the timeout window.",
            modelName: this.dependencies.provider.model ?? null,
            providerName: this.dependencies.provider.name,
            reason: details.lastActivityReason ?? "no recent runtime activity"
          },
          stage: "planning",
          taskId
        });
      }
    });

    try {
      managedAbortController.touchActivity("task_started");
      task = this.dependencies.taskRepository.update(taskId, {
        startedAt: new Date().toISOString(),
        status: "running"
      });
      emitTaskEvent(options.onTaskEvent, {
        iteration: task.currentIteration,
        kind: "lifecycle",
        message: "Task started",
        status: task.status,
        taskId
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "task_started",
        payload: {
          maxIterations: options.maxIterations,
          timeoutMode,
          timeoutMs: options.timeoutMs
        },
        stage: "lifecycle",
        summary: "Task execution started",
        taskId
      });

      const profile = this.dependencies.agentProfileRegistry.get(options.agentProfileId);
      const sessionId = task.sessionId ?? null;
      const initialToolExposure = this.dependencies.toolExposurePlanner
        ? await this.dependencies.toolExposurePlanner.plan(
            buildToolExposurePlannerInput({
              context: {
                agentProfileId: options.agentProfileId,
                cwd: options.cwd,
                iteration: 1,
                signal: managedAbortController.abortController.signal,
                taskId,
                taskMetadata: buildToolTaskMetadata(task),
                userId: options.userId,
                workspaceRoot: this.dependencies.workspaceRoot
              },
              interactionMode: options.interactionMode,
              iteration: 1,
              taskId,
              sessionId
            })
          )
        : null;
      managedAbortController.touchActivity("tool_exposure_planned");
      const availableTools =
        initialToolExposure?.tools ?? this.dependencies.toolOrchestrator.listTools();
      const recallPlan = await this.planRecall({
        task,
        sessionCommitmentState:
          sessionId === null ? null : this.dependencies.getSessionCommitmentState?.(sessionId) ?? null,
        tokenBudget: options.tokenBudget,
        toolPlan: availableTools.map((tool) => tool.name)
      });
      managedAbortController.touchActivity("recall_planned");
      const repoMap = this.dependencies.workflow.repoMap.enabled
        ? buildRepoMap(this.dependencies.workspaceRoot)
        : null;
      managedAbortController.touchActivity("repo_map_created");
      const messages = this.contextAssembler.buildInitialMessages(
        task,
        availableTools,
        profile,
        repoMap?.summary,
        initialToolExposure?.decisions ?? []
      );
      const resumeContextMessages = readSessionResumeMessages(taskMetadata);
      if (resumeContextMessages.length > 0) {
        injectResumeContextMessages(messages, resumeContextMessages);
        const priorTaskMessage = resumeContextMessages.find(
          (message) => message.metadata?.sourceType === PRIOR_TASK_RESULT_SOURCE_TYPE
        );
        if (priorTaskMessage !== undefined) {
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "prior_task_context_injected",
            payload: {
              priorTaskId: readSessionResumePriorTaskId(taskMetadata) ?? "unknown",
              truncated: priorTaskMessage.content.includes("...[prior task output truncated]")
            },
            stage: "planning",
            summary: "Injected prior task final output into session continuation context",
            taskId
          });
        }
      }
      const resumeMemoryContext = readSessionResumeMemoryContext(taskMetadata);
      if (repoMap !== null) {
        this.dependencies.traceService.record({
          actor: "runtime.repo_map",
          eventType: "repo_map_created",
          payload: {
            importantFiles: repoMap.importantFiles,
            languages: repoMap.languages,
            packageManager: repoMap.packageManager,
            scripts: repoMap.scripts
          },
          stage: "planning",
          summary: repoMap.summary,
          taskId
        });
      }

      return await this.executeLoop({
        ...this.createContextLoopFields(),
        cwd: options.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        intentFulfillmentGuardEmitted: false,
        interactionMode: options.interactionMode,
        managedAbortController,
        maxIterations: options.maxIterations,
        memoryContext: [...recallPlan.fragments, ...resumeMemoryContext],
        memoryRecall: null,
        messages,
        ...(options.onAssistantTextDelta !== undefined
          ? { onAssistantTextDelta: options.onAssistantTextDelta }
          : {}),
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        ...(options.onTaskEvent !== undefined ? { onTaskEvent: options.onTaskEvent } : {}),
        pendingToolCalls: [],
        postCompletionVerificationReads: 0,
        ...(repoMap?.summary !== undefined ? { repoMapSummary: repoMap.summary } : {}),
        selectedSkillContext: recallPlan.fragments.filter((fragment) => fragment.scope === "skill_ref"),
        silentToolTurns: 0,
        task,
        toolCallSignatures: new Map(),
        turnFilteredFragments: [],
        turnProviderMessages: messages,
        tokenBudget: options.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeToolSucceeded: false
      });
    } catch (error) {
      throw this.finalizeTaskFailure(task, toAppError(error), options.onTaskEvent);
    } finally {
      stopOutputSubscription?.();
      managedAbortController.dispose();
    }
  }

  public async resumeTask(
    taskId: string,
    options: { onOutputEvent?: (event: RuntimeOutputEvent) => void; signal?: AbortSignal } = {}
  ): Promise<RuntimeRunResult> {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_approval" && task.status !== "waiting_clarification") {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} is not waiting for approval or clarification.`
      });
    }

    const resumeCheckpoint = this.checkpointManager.loadForResume(task);
    const checkpoint = resumeCheckpoint.checkpoint;

    const runMetadata = this.dependencies.runMetadataRepository.findByTaskId(taskId);
    if (runMetadata === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no run metadata to resume from.`
      });
    }

    const managedAbortController = createManagedAbortController(runMetadata.timeoutMs, options.signal);
    const stopOutputSubscription =
      options.onOutputEvent === undefined
        ? null
        : this.dependencies.outputService.subscribe((event) => {
            if (event.taskId === taskId) {
              options.onOutputEvent?.(event);
            }
          });
    let resumedTask = this.dependencies.taskRepository.update(taskId, {
      status: "running"
    });

    try {
      return await this.executeLoop({
        ...this.createContextLoopFields(),
        cwd: resumedTask.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        intentFulfillmentGuardEmitted: false,
        interactionMode: readInteractionModeFromMetadata(runMetadata.metadata),
        managedAbortController,
        maxIterations: resumedTask.maxIterations,
        memoryContext: checkpoint.memoryContext,
        memoryRecall: null,
        messages: checkpoint.messages,
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        pendingToolCalls: checkpoint.pendingToolCalls,
        postCompletionVerificationReads: 0,
        selectedSkillContext: [],
        silentToolTurns: 0,
        task: resumedTask,
        toolCallSignatures: resumeCheckpoint.toolCallSignatures,
        turnFilteredFragments: [],
        turnProviderMessages: checkpoint.messages,
        tokenBudget: resumedTask.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeToolSucceeded: resumeCheckpoint.writeToolSucceeded
      });
    } catch (error) {
      resumedTask = this.dependencies.taskRepository.findById(taskId) ?? resumedTask;
      throw this.finalizeTaskFailure(resumedTask, toAppError(error));
    } finally {
      stopOutputSubscription?.();
      managedAbortController.dispose();
    }
  }

  public async resumeTaskAfterApprovalFailure(
    taskId: string,
    toolCallId: string,
    options: { onOutputEvent?: (event: RuntimeOutputEvent) => void; signal?: AbortSignal } = {}
  ): Promise<RuntimeRunResult> {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_approval") {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} is not waiting for approval.`
      });
    }

    const resumeCheckpoint = this.checkpointManager.loadForResume(task);
    const checkpoint = resumeCheckpoint.checkpoint;
    const rejectedToolCall = checkpoint.pendingToolCalls.find(
      (toolCall) => toolCall.toolCallId === toolCallId
    );
    if (rejectedToolCall === undefined) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} checkpoint has no pending tool call ${toolCallId}.`
      });
    }

    const runMetadata = this.dependencies.runMetadataRepository.findByTaskId(taskId);
    if (runMetadata === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no run metadata to resume from.`
      });
    }

    const managedAbortController = createManagedAbortController(runMetadata.timeoutMs, options.signal);
    const stopOutputSubscription =
      options.onOutputEvent === undefined
        ? null
        : this.dependencies.outputService.subscribe((event) => {
            if (event.taskId === taskId) {
              options.onOutputEvent?.(event);
            }
          });
    let resumedTask = this.dependencies.taskRepository.update(taskId, {
      status: "running"
    });

    try {
      return await this.executeLoop({
        ...this.createContextLoopFields(),
        cwd: resumedTask.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        intentFulfillmentGuardEmitted: false,
        interactionMode: readInteractionModeFromMetadata(runMetadata.metadata),
        managedAbortController,
        maxIterations: resumedTask.maxIterations,
        memoryContext: checkpoint.memoryContext,
        memoryRecall: null,
        messages: checkpoint.messages,
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        pendingToolCalls: [rejectedToolCall],
        postCompletionVerificationReads: 0,
        selectedSkillContext: [],
        silentToolTurns: 0,
        task: resumedTask,
        toolCallSignatures: resumeCheckpoint.toolCallSignatures,
        turnFilteredFragments: [],
        turnProviderMessages: checkpoint.messages,
        tokenBudget: resumedTask.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeToolSucceeded: resumeCheckpoint.writeToolSucceeded
      });
    } catch (error) {
      resumedTask = this.dependencies.taskRepository.findById(taskId) ?? resumedTask;
      throw this.finalizeTaskFailure(resumedTask, toAppError(error));
    } finally {
      stopOutputSubscription?.();
      managedAbortController.dispose();
    }
  }

  public failWaitingApprovalTask(taskId: string, error: AppError): TaskRecord {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_approval") {
      return task;
    }

    this.checkpointManager.delete(taskId);
    const failedTask = this.dependencies.taskRepository.update(taskId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status: "failed"
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        output: null,
        status: "failed"
      },
      stage: "completion",
      summary: "Task finished with an approval failure",
      taskId
    });

    return failedTask;
  }

  public failWaitingClarificationTask(taskId: string, error: AppError): TaskRecord {
    const task = this.dependencies.taskRepository.findById(taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${taskId} was not found.`
      });
    }

    if (task.status !== "waiting_clarification") {
      return task;
    }

    this.checkpointManager.delete(taskId);
    const failedTask = this.dependencies.taskRepository.update(taskId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status: "failed"
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        output: null,
        status: "failed"
      },
      stage: "completion",
      summary: "Task finished with a clarification failure",
      taskId
    });

    return failedTask;
  }

  private async executeLoop(state: ExecutionLoopState): Promise<RuntimeRunResult> {
    let availableTools = this.dependencies.toolOrchestrator.listTools();
    let task = state.task;
    const messages = [...state.messages];
    let pendingToolCalls = [...state.pendingToolCalls];
    let lastToolCallsResponse: Extract<ProviderResponse, { kind: "tool_calls" }> | null = null;

    for (
      let iteration = pendingToolCalls.length > 0 ? task.currentIteration : task.currentIteration + 1;
      iteration <= state.maxIterations;
      iteration += 1
    ) {
      this.completionController.maybeInjectIterationBudgetPressure(
        state,
        task.taskId,
        iteration
      );
      throwIfAborted(
        state.managedAbortController.abortController.signal,
        state.managedAbortController.getReason()
      );

      task = this.dependencies.taskRepository.update(task.taskId, {
        currentIteration: iteration
      });

      if (pendingToolCalls.length === 0) {
        const baseAvailableTools = this.dependencies.toolOrchestrator.listTools();
        if (this.dependencies.toolExposurePlanner !== undefined) {
          const exposure = await this.dependencies.toolExposurePlanner.plan(
            buildToolExposurePlannerInput({
              context: {
                agentProfileId: state.task.agentProfileId,
                cwd: state.cwd,
                iteration,
                signal: state.managedAbortController.abortController.signal,
                taskId: task.taskId,
                taskMetadata: buildToolTaskMetadata(task),
                userId: task.requesterUserId,
                workspaceRoot: this.dependencies.workspaceRoot
              },
              interactionMode: state.interactionMode,
              iteration,
              taskId: task.taskId,
              sessionId: task.sessionId ?? null
            })
          );
          availableTools = exposure.tools;
          state.costWarnedToolNames = exposure.decisions
            .filter((decision) => decision.costWarning === true)
            .map((decision) => decision.toolName);
          state.managedAbortController.touchActivity("tool_exposure_planned");
        } else {
          availableTools = baseAvailableTools;
        }
        this.syncRecentFileCacheMode(state, pendingToolCalls, availableTools);
        sanitizeToolCallPairing(state.turnProviderMessages);
        const pruneResult = pruneOldToolResults(state.turnProviderMessages);
        if (pruneResult.prunedCount > 0) {
          state.microPrunedCount += pruneResult.prunedCount;
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "micro_compact_pruned",
            payload: {
              iteration,
              prunedCount: pruneResult.prunedCount,
              savedTokensEstimate: pruneResult.savedTokensEstimate
            },
            stage: "planning",
            summary: `Micro-compaction pruned ${pruneResult.prunedCount} old tool results`,
            taskId: task.taskId
          });
        }
        syncPinnedRecentFilesMessage(state.turnProviderMessages, state.recentFileReadCache);
        const injectedTodos = this.syncSessionTodosContext({
          iteration,
          messages: state.turnProviderMessages,
          task
        });
        if (injectedTodos !== null) {
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "session_todos_injected",
            payload: {
              iteration,
              todoCount: injectedTodos.todoCount
            },
            stage: "planning",
            summary: `Injected ${injectedTodos.todoCount} session todo item(s) into provider messages`,
            taskId: task.taskId
          });
        }
        const assembled = this.contextAssembler.assemble({
          availableTools,
          filteredOutFragments: state.turnFilteredFragments,
          iteration,
          memoryContext: state.memoryContext,
          messages: state.turnProviderMessages,
          signal: state.managedAbortController.abortController.signal,
          task,
          tokenBudget: state.tokenBudget
        });
        assembled.debug.filteredOutFragments =
          (state.memoryRecall === null
            ? []
            : buildFilteredContextDebugFragments(state.memoryRecall.decisions)).concat(
            assembled.debug.filteredOutFragments
          );
        state.managedAbortController.touchActivity("context_assembled");
        if (assembled.memoryContextInjection !== null) {
          this.dependencies.traceService.record({
            actor: "runtime.context",
            eventType: "memory_context_injected",
            payload: {
              fragmentCount: assembled.memoryContextInjection.fragmentCount,
              iteration,
              tokenEstimate: assembled.memoryContextInjection.tokenEstimate
            },
            stage: "planning",
            summary: `Injected ${assembled.memoryContextInjection.fragmentCount} recall fragments into provider messages`,
            taskId: task.taskId
          });
        }
        const turnId = randomUUID();
        this.emitOutput({
          eventType: "assistant_turn_started",
          payload: {
            display: "provisional",
            iteration,
            providerName: this.dependencies.provider.name,
            turnId
          },
          stage: "planning",
          taskId: task.taskId
        });
        const providerInput = {
          ...assembled.providerInput,
          onTextDelta: (delta: string) => {
            state.managedAbortController.touchActivity("assistant_turn_delta");
            state.onAssistantTextDelta?.(delta);
            this.emitOutput({
              eventType: "assistant_turn_delta",
              payload: {
                delta,
                display: "provisional",
                iteration,
                turnId
              },
              stage: "planning",
              taskId: task.taskId
            });
          },
          onProviderStatus: (notice: ProviderStatusNotice) => {
            state.managedAbortController.touchActivity("provider_status");
            this.emitOutput({
              eventType: "provider_status",
              payload: notice,
              stage: "planning",
              taskId: task.taskId
            });
          },
          onRetry: (retry: ProviderRetryNotice) => {
            state.managedAbortController.touchActivity("provider_retry_scheduled");
            this.dependencies.traceService.record({
              actor: `provider.${retry.providerName}`,
              eventType: "provider_retry_scheduled",
              payload: {
                ...retry,
                iteration
              },
              stage: "planning",
              summary: `Provider retry ${retry.attempt}/${retry.maxRetries} scheduled after ${retry.errorCategory}`,
              taskId: task.taskId
            });
          }
        };

        this.dependencies.traceService.record({
          actor: "runtime.context",
          eventType: "context_assembled",
          payload: {
            compactedCount: state.compactedCount,
            debugView: assembled.debug,
            iteration,
            microPrunedCount: state.microPrunedCount,
            promptTokenEstimate: computePromptTokens(state.tokenCounter, state.turnProviderMessages)
          },
          stage: "planning",
          summary: `Context assembled with ${assembled.debug.memoryRecallFragments.length} recall fragments`,
          taskId: task.taskId
        });

        const activeProvider = this.resolveActiveMainProvider(task);

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "provider_request_started",
          payload: {
            inputMessageCount: state.turnProviderMessages.length,
            iteration,
            modelName: activeProvider.model ?? activeProvider.describe?.().model ?? null,
            providerName: activeProvider.name
          },
          stage: "planning",
          summary: "Provider request started",
          taskId: task.taskId
        });
        state.managedAbortController.touchActivity("provider_request_started");

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "model_request",
          payload: {
            agentProfileId: task.agentProfileId,
            availableTools: availableTools.map((tool) => tool.name),
            inputMessageCount: state.turnProviderMessages.length,
            iteration,
            tokenBudget: tokenBudgetToJson(state.tokenBudget)
          },
          stage: "planning",
          summary: "Provider request assembled",
          taskId: task.taskId
        });

        const startedAt = Date.now();
        let providerResponse;
        let reactiveCompactUsed = false;
        for (let providerAttempt = 0; providerAttempt < 2; providerAttempt += 1) {
          try {
            providerResponse = await generateWithProviderFailover(
              {
                auditService: this.dependencies.auditService,
                cwd: this.dependencies.workspaceRoot,
                enableFailover: true,
                primaryProvider: activeProvider,
                taskId: task.taskId,
                traceService: this.dependencies.traceService
              },
              providerInput
            );
            break;
          } catch (error) {
            const providerError = normalizeProviderFailure(error, activeProvider);
            if (
              !reactiveCompactUsed &&
              isContextOverflowProviderError(providerError as ProviderError)
            ) {
              const droppedFromTurn = dropOldestNonSystemMessages(state.turnProviderMessages);
              const droppedFromMessages = dropOldestNonSystemMessages(messages);
              if (droppedFromTurn > 0 || droppedFromMessages > 0) {
                reactiveCompactUsed = true;
                this.dependencies.traceService.record({
                  actor: "runtime.context",
                  eventType: "reactive_compact_triggered",
                  payload: {
                    droppedMessageCount: Math.max(droppedFromTurn, droppedFromMessages),
                    iteration
                  },
                  stage: "planning",
                  summary: "Dropped oldest messages after provider context overflow",
                  taskId: task.taskId
                });
                continue;
              }
            }
            const abortReason = state.managedAbortController.getReason();
            const signalAborted = state.managedAbortController.abortController.signal.aborted;
            const timeoutSource =
              signalAborted && abortReason === "timeout"
                ? state.managedAbortController.timeoutMode
                : providerError.category === "timeout_error"
                  ? "provider"
                  : undefined;
            this.dependencies.traceService.record({
              actor: `provider.${activeProvider.name}`,
              eventType: "provider_request_failed",
              payload: {
                errorCategory:
                  signalAborted && abortReason === "timeout" ? "timeout_error" : providerError.category,
                errorMessage: providerError.message,
                iteration,
                lastActivityReason: state.managedAbortController.getLastActivityReason(),
                latencyMs: Date.now() - startedAt,
                modelName: providerError.modelName ?? activeProvider.model ?? null,
                providerName: activeProvider.name,
                retryCount: providerError.retryCount,
                timeoutMs: state.managedAbortController.timeoutMs,
                ...(timeoutSource !== undefined ? { timeoutSource } : {})
              },
              stage: "planning",
              summary: `Provider request failed with ${
                signalAborted && abortReason === "timeout" ? "timeout_error" : providerError.category
              }`,
              taskId: task.taskId
            });
            if (signalAborted) {
              throwIfAborted(state.managedAbortController.abortController.signal, abortReason);
            }
            throw providerError;
          }
        }
        if (providerResponse === undefined) {
          throw new AppError({
            code: "provider_error",
            message: "Provider request failed after reactive compaction retry."
          });
        }
        state.managedAbortController.touchActivity("provider_request_succeeded");
        const assistantDisplay = providerResponse.kind === "final" ? "final" : "intermediate";
        const transcriptVisibility =
          providerResponse.kind === "tool_calls" ? "hidden" : "visible";

        const assistantReasoningContent =
          providerResponse.kind === "final" || providerResponse.kind === "tool_calls"
            ? providerResponse.reasoningContent
            : undefined;
        messages.push({
          content: providerResponse.message,
          role: "assistant",
          ...(providerResponse.metadata?.raw !== undefined
            ? { metadata: providerResponse.metadata.raw }
            : {}),
          ...(assistantReasoningContent !== undefined
            ? { reasoningContent: assistantReasoningContent }
            : {}),
          ...(providerResponse.kind === "tool_calls"
            ? { toolCalls: providerResponse.toolCalls }
            : {})
        });
        this.emitOutput({
          eventType: "assistant_turn_completed",
          payload: {
            display: assistantDisplay,
            iteration,
            text: providerResponse.message,
            transcriptVisibility,
            turnId
          },
          stage: assistantDisplay === "final" ? "completion" : "planning",
          taskId: task.taskId
        });
        state.managedAbortController.touchActivity("assistant_turn_completed");

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "provider_request_succeeded",
          payload: {
            iteration,
            kind: providerResponse.kind,
            latencyMs: Date.now() - startedAt,
            modelName:
              providerResponse.metadata?.modelName ??
              activeProvider.model ??
              activeProvider.describe?.().model ??
              null,
            providerName:
              providerResponse.metadata?.providerName ?? activeProvider.name,
            retryCount: providerResponse.metadata?.retryCount ?? 0,
            usage: providerUsageToJson(providerResponse.usage)
          },
          stage: "planning",
          summary: `Provider request completed with ${providerResponse.kind}`,
          taskId: task.taskId
        });

        this.dependencies.traceService.record({
          actor: `provider.${activeProvider.name}`,
          eventType: "model_response",
          payload: {
            iteration,
            kind: providerResponse.kind,
            message: providerResponse.message,
            toolNames:
              providerResponse.kind === "tool_calls"
                ? providerResponse.toolCalls.map((call: ProviderToolCall) => call.toolName)
                : []
          },
          stage: "planning",
          summary: `Provider responded with ${providerResponse.kind}`,
          taskId: task.taskId
        });

        const resolvedProviderName = providerResponse.metadata?.providerName ?? activeProvider.name;
        const budgetResult = this.budgetRecorder.record({
          providerName: resolvedProviderName,
          providerResponse,
          task,
          tokenBudget: state.tokenBudget
        });
        task = budgetResult.task;
        state.tokenBudget = budgetResult.tokenBudget;
        state.tokenCounter = recordApiUsage(
          state.tokenCounter,
          providerResponse.usage.inputTokens,
          messages.length - 1
        );

        if (task.agentProfileId === "reviewer") {
          this.dependencies.traceService.record({
            actor: "reviewer.trace",
            eventType: "reviewer_trace",
            payload: buildReviewerTracePayload(iteration, assembled.debug, providerResponse),
            stage: "planning",
            summary: "Reviewer decision trace captured",
            taskId: task.taskId
          });
        }

        if (providerResponse.kind === "retry") {
          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "retry",
            payload: {
              delayMs: providerResponse.delayMs,
              iteration,
              reason: providerResponse.reason
            },
            stage: "control",
            summary: "Retry requested by provider",
            taskId: task.taskId
          });

          await sleepWithAbort(
            providerResponse.delayMs,
            state.managedAbortController.abortController.signal
          );

          this.dependencies.traceService.record({
            actor: "runtime.kernel",
            eventType: "loop_iteration_completed",
            payload: {
              iteration,
              toolCallCount: 0
            },
            stage: "control",
            summary: "Loop iteration completed after retry",
            taskId: task.taskId
          });
          continue;
        }

        if (providerResponse.kind === "final") {
          const intentDecision = this.completionController.evaluateIntentFulfillment(
            state,
            messages,
            task,
            iteration,
            task.input,
            providerResponse.message
          );
          if (intentDecision === "guard") {
            continue;
          }
          const verificationDecision = this.completionController.evaluateFinalVerification(
            state,
            messages,
            task,
            iteration,
            providerResponse.message
          );
          if (verificationDecision.kind === "guard") {
            continue;
          }
          return this.completeTaskSuccess(
            state,
            messages,
            availableTools,
            task,
            verificationDecision.finalOutput
          );
        }

        const postCompletionDecision = this.completionController.evaluatePostCompletionToolCalls(
          state,
          iteration,
          providerResponse
        );
        if (postCompletionDecision === "summarize") {
          return this.requestFinalSummaryWithoutTools(
            state,
            messages,
            availableTools,
            task,
            iteration,
            "post_completion_verification_exhausted"
          );
        }

        task = this.dependencies.taskRepository.update(task.taskId, {
          status: "waiting_tool"
        });
        pendingToolCalls = providerResponse.toolCalls;
        lastToolCallsResponse = providerResponse;
        state.managedAbortController.touchActivity("tool_call_requested");
      }

      let toolCallCount = 0;
      const parallelSafeByToolName = buildParallelSafeLookup(
        this.dependencies.toolOrchestrator.listToolsWithMetadata()
      );
      const isParallelSafe = (toolName: string): boolean =>
        parallelSafeByToolName.get(toolName) ?? false;

      let toolCallIndex = 0;
      while (toolCallIndex < pendingToolCalls.length) {
        throwIfAborted(
          state.managedAbortController.abortController.signal,
          state.managedAbortController.getReason()
        );

        const currentToolCall = pendingToolCalls[toolCallIndex];
        if (currentToolCall === undefined) {
          break;
        }

        if (!isParallelSafe(currentToolCall.toolName)) {
          const replayed = this.tryApplyDuplicateToolReplay(
            state,
            messages,
            task,
            iteration,
            currentToolCall
          );
          if (replayed) {
            toolCallCount += 1;
            toolCallIndex += 1;
            continue;
          }
          const invocation = await this.invokeToolCall(state, task, iteration, currentToolCall);
          const paused = this.tryPauseToolExecution(
            state,
            messages,
            pendingToolCalls,
            toolCallIndex,
            task,
            iteration,
            invocation
          );
          if (paused !== null) {
            return paused;
          }
          this.applyCompletedToolCallOutcome(
            state,
            messages,
            task,
            iteration,
            invocation.toolCall,
            invocation.outcome
          );
          toolCallCount += 1;
          toolCallIndex += 1;
          continue;
        }

        const batchStartIndex = toolCallIndex;
        const batchCalls: ProviderToolCall[] = [];
        while (toolCallIndex < pendingToolCalls.length) {
          const batchToolCall = pendingToolCalls[toolCallIndex];
          if (batchToolCall === undefined || !isParallelSafe(batchToolCall.toolName)) {
            break;
          }
          batchCalls.push(batchToolCall);
          toolCallIndex += 1;
        }

        const batchResult = await this.executeParallelToolBatch(
          state,
          messages,
          pendingToolCalls,
          batchCalls,
          batchStartIndex,
          task,
          iteration
        );
        if (batchResult.kind === "paused") {
          return batchResult.result;
        }
        toolCallCount += batchResult.toolCallCount;
      }

      if (toolCallCount > 0) {
        const toolTurnResponse =
          lastToolCallsResponse ?? findLastAssistantToolCallsResponse(messages);
        if (toolTurnResponse !== null) {
          this.completionController.observeProviderToolTurn(state, messages, iteration, toolTurnResponse);
        }
        lastToolCallsResponse = null;
      }

      pendingToolCalls = [];
      this.checkpointManager.delete(task.taskId);
      state.turnProviderMessages = rebuildTurnProviderMessages(messages, state.turnProviderMessages);

      task = this.dependencies.taskRepository.update(task.taskId, {
        status: "running"
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "loop_iteration_completed",
        payload: {
          iteration,
          toolCallCount
        },
        stage: "control",
        summary: "Loop iteration completed after tool execution",
        taskId: task.taskId
      });
      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "turn_end",
        payload: {
          iteration,
          taskStatus: task.status,
          toolCallCount
        },
        stage: "lifecycle",
        summary: "Turn end lifecycle hook published",
        taskId: task.taskId
      });

      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "pre_compress",
        payload: {
          messageCount: messages.length,
          reason: "message_count"
        },
        stage: "lifecycle",
        summary: "Pre-compress lifecycle hook published",
        taskId: task.taskId
      });
      const compactInputBase = this.buildCompactInput({
        iteration,
        messages,
        pendingToolCalls,
        state,
        task
      });
      const manualCompactRequest =
        this.dependencies.manualCompactCoordinator?.consume(task.taskId) ?? null;
      if (manualCompactRequest !== null) {
        this.dependencies.traceService.record({
          actor: "runtime.context",
          eventType: "manual_compact_triggered",
          payload: {
            iteration,
            ...(manualCompactRequest.focusTopic !== undefined
              ? { focusTopic: manualCompactRequest.focusTopic }
              : {})
          },
          stage: "memory",
          summary: "Manual compaction requested",
          taskId: task.taskId
        });
      }
      const compacted = await this.compactMessages(
        {
          ...compactInputBase,
          ...(manualCompactRequest?.focusTopic !== undefined
            ? { focusTopic: manualCompactRequest.focusTopic }
            : {})
        },
        manualCompactRequest
      );
      if (compacted.triggered) {
        const compactReason = compacted.reason ?? "message_count";
        const preCompactMessages = [...messages];
        if (task.sessionId !== null && task.sessionId !== undefined) {
          const sessionId = task.sessionId;
          const latestRun = this.dependencies.sessionTaskRepository.findLatestBySessionId(sessionId);
          this.dependencies.sessionLineageRepository.append({
            eventType: "compress",
            lineageId: randomUUID(),
            payload: {
              messageCount: messages.length,
              reason: compactReason
            },
            sourceRunId: latestRun?.runId ?? null,
            targetRunId: latestRun?.runId ?? null,
            sessionId
          });
          const compactInput = {
            ...this.buildCompactInput({
              iteration,
              messages: preCompactMessages,
              pendingToolCalls,
              state,
              task
            }),
            reason: compactReason
          } as const;
          const workerDispatcher = this.dependencies.workerDispatcher;
          const summarizerWorker = this.dependencies.summarizerWorker;
          const persistCompactSummary = (): void => {
            const sessionSummaryDraft = this.dependencies.contextCompactor.buildSessionSummary({
              availableTools,
              compact: compactInput,
              task
            });
            this.dependencies.sessionSummaryService.create({
              ...sessionSummaryDraft,
              metadata: {
                ...(sessionSummaryDraft.metadata ?? {}),
                compactReason,
                replacedMessageCount: Math.max(
                  0,
                  preCompactMessages.length - compacted.replacementMessages.length
                )
              },
              runId: latestRun?.runId ?? null,
              sessionId,
              trigger: "compact"
            });
          };
          if (workerDispatcher !== undefined && summarizerWorker !== undefined) {
            const workerResult = await workerDispatcher.dispatch(
              {
                backoffBaseMs: 150,
                backoffMaxMs: 1000,
                input: {
                  availableTools,
                  compactInput,
                  compactResult: compacted,
                  runId: latestRun?.runId ?? null,
                  task
                },
                maxAttempts: 2,
                taskId: task.taskId,
                sessionId,
                timeoutMs: 5_000,
                workerId: randomUUID(),
                workerKind: "summarizer"
              },
              (input) => summarizerWorker.execute(input)
            );
            if (workerResult.status !== "succeeded") {
              persistCompactSummary();
            }
          } else {
            persistCompactSummary();
          }
        }
        const initialSystemPrompt =
          messages.find((message) => message.role === "system") ?? null;
        messages.length = 0;
        state.silentToolTurns = 0;
        if (initialSystemPrompt !== null) {
          messages.push(initialSystemPrompt);
        }
        if (state.repoMapSummary !== undefined) {
          messages.push({
            content: state.repoMapSummary,
            metadata: {
              privacyLevel: "internal",
              retentionKind: "session",
              sourceType: "system_prompt"
            },
            role: "system"
          });
        }
        messages.push({
          content: buildCapabilityDeclaration({
            agentProfileId: task.agentProfileId,
            availableTools,
            costWarnedToolNames: state.costWarnedToolNames,
            skillContext: state.selectedSkillContext
          }),
          metadata: {
            privacyLevel: "internal",
            retentionKind: "session",
            sourceType: "system_prompt"
          },
          role: "system"
        });
        messages.push(...compacted.replacementMessages);
        syncPinnedRecentFilesMessage(messages, state.recentFileReadCache);
        this.syncSessionTodosContext({
          messages,
          task
        });
        state.compactedCount += 1;
        state.tokenCounter = createHybridTokenCounterState();
        const refreshSessionId = task.sessionId ?? null;
        const refreshedContext = await this.planRecall({
          task,
          sessionCommitmentState:
            refreshSessionId === null
              ? null
              : this.dependencies.getSessionCommitmentState?.(refreshSessionId) ?? null,
          tokenBudget: state.tokenBudget,
          toolPlan: availableTools.map((tool) => tool.name)
        });
        state.memoryContext = refreshedContext.fragments;
        state.memoryRecall = null;
        state.selectedSkillContext = refreshedContext.fragments.filter(
          (fragment) => fragment.scope === "skill_ref"
        );
        state.turnProviderMessages = rebuildTurnProviderMessages(messages, state.turnProviderMessages);
      }
    }

    return this.requestFinalSummaryWithoutTools(
      state,
      messages,
      availableTools,
      task,
      state.maxIterations,
      "max_iterations_exhausted"
    );
  }

  private async requestFinalSummaryWithoutTools(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    availableTools: ProviderToolDescriptor[],
    task: TaskRecord,
    iteration: number,
    reason: "max_iterations_exhausted" | "post_completion_verification_exhausted"
  ): Promise<RuntimeRunResult> {
    const activeProvider = this.resolveActiveMainProvider(task);
    const summaryPrompt =
      reason === "max_iterations_exhausted"
        ? `The loop reached its iteration budget (${state.maxIterations}). Do not call tools. Summarize the completed work, files changed or inspected, and any remaining work.`
        : "The task appears complete and further verification reads are no longer useful. Do not call tools. Provide the final answer now with completed work and any remaining notes.";
    const finalMessages: ConversationMessage[] = [
      ...state.turnProviderMessages,
      {
        content: summaryPrompt,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      }
    ];
    const startedAt = Date.now();
    let providerResponse: ProviderResponse;
    try {
      providerResponse = await generateWithProviderFailover(
        {
          auditService: this.dependencies.auditService,
          cwd: this.dependencies.workspaceRoot,
          enableFailover: true,
          primaryProvider: activeProvider,
          taskId: task.taskId,
          traceService: this.dependencies.traceService
        },
        {
          agentProfileId: task.agentProfileId,
          availableTools: [],
          iteration: iteration + 1,
          memoryContext: state.memoryContext,
          messages: finalMessages,
          ...(state.onAssistantTextDelta !== undefined
            ? { onTextDelta: state.onAssistantTextDelta }
            : {}),
          signal: state.managedAbortController.abortController.signal,
          task,
          tokenBudget: state.tokenBudget
        }
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new AppError({
          code: "interrupt",
          message: error.message
        });
      }
      throw toAppError(error);
    }
    state.managedAbortController.touchActivity("no_tools_final_summary");

    this.dependencies.traceService.record({
      actor: `provider.${activeProvider.name}`,
      eventType: "provider_request_succeeded",
      payload: {
        iteration: iteration + 1,
        kind: providerResponse.kind,
        latencyMs: Date.now() - startedAt,
        modelName:
          providerResponse.metadata?.modelName ??
          activeProvider.model ??
          activeProvider.describe?.().model ??
          null,
        providerName: providerResponse.metadata?.providerName ?? activeProvider.name,
        retryCount: providerResponse.metadata?.retryCount ?? 0,
        usage: providerUsageToJson(providerResponse.usage)
      },
      stage: "completion",
      summary: `No-tools final summary completed with ${providerResponse.kind}`,
      taskId: task.taskId
    });

    if (providerResponse.kind === "tool_calls") {
      this.dependencies.traceService.record({
        actor: `provider.${activeProvider.name}`,
        eventType: "no_tools_tool_calls_ignored",
        payload: {
          iteration: iteration + 1,
          message: providerResponse.message,
          reason,
          toolNames: providerResponse.toolCalls.map((call) => call.toolName)
        },
        stage: "completion",
        summary: "Ignored tool calls from no-tools final summary",
        taskId: task.taskId
      });
    }

    const finalMessage = providerResponse.message.trim();
    if (finalMessage.length === 0) {
      throw new AppError({
        code: "max_rounds_exceeded",
        message: `Task exceeded ${state.maxIterations} iterations.`
      });
    }

    messages.push({
      content: finalMessage,
      role: "assistant",
      ...(providerResponse.metadata?.raw !== undefined
        ? { metadata: providerResponse.metadata.raw }
        : {})
    });
    return this.completeTaskSuccess(state, messages, availableTools, task, finalMessage);
  }

  private completeTaskSuccess(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    availableTools: ProviderToolDescriptor[],
    task: TaskRecord,
    finalOutput: string
  ): RuntimeRunResult {
    this.checkpointManager.delete(task.taskId);
    const completedTask = this.dependencies.taskRepository.update(task.taskId, {
      finalOutput,
      finishedAt: new Date().toISOString(),
      status: "succeeded"
    });
    this.dependencies.memoryPlane.recordFinalOutcome(completedTask, finalOutput);
    this.appendSessionTranscript(completedTask, {
      content: finalOutput,
      eventType: "assistant_message",
      payload: {
        source: "final_output"
      },
      role: "assistant"
    });
    this.appendSessionTranscript(completedTask, {
      content: summarizeText(finalOutput, 240),
      eventType: "task_result",
      payload: {
        status: "succeeded"
      },
      role: "system"
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: null,
        errorMessage: null,
        output: finalOutput,
        status: "succeeded"
      },
      stage: "completion",
      summary: "Task completed successfully",
      taskId: completedTask.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_success",
      payload: {
        cwd: completedTask.cwd,
        outputSummary: summarizeText(finalOutput, 240),
        status: "succeeded"
      },
      stage: "lifecycle",
      summary: "Task success lifecycle hook published",
      taskId: completedTask.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "session_end",
      payload: {
        status: "succeeded",
        summary: summarizeText(finalOutput, 240)
      },
      stage: "lifecycle",
      summary: "Session end lifecycle hook published",
      taskId: completedTask.taskId
    });
    emitTaskEvent(state.onTaskEvent, {
      errorCode: null,
      errorMessage: null,
      kind: "result",
      outputPreview: summarizeText(finalOutput, 200),
      status: "succeeded",
      taskId: completedTask.taskId
    });

    this.persistSessionTask(completedTask, completedTask.input, {
      finalOutput,
      status: completedTask.status
    });
    if (completedTask.sessionId !== null && completedTask.sessionId !== undefined) {
      const latestRun =
        this.dependencies.sessionTaskRepository.findByTaskId(completedTask.taskId) ??
        this.dependencies.sessionTaskRepository.findLatestBySessionId(completedTask.sessionId);
      const finalSessionSummaryDraft = this.dependencies.contextCompactor.buildSessionSummary({
        availableTools,
        compact: buildFinalSessionCompactInput(messages, completedTask),
        task: completedTask,
        trigger: "final"
      });
      this.dependencies.sessionSummaryService.create({
        ...finalSessionSummaryDraft,
        runId: latestRun?.runId ?? null,
        sessionId: completedTask.sessionId,
        trigger: "final"
      });
    }

    this.projectSessionMessages(completedTask, finalOutput);

    return {
      output: finalOutput,
      task: completedTask
    };
  }

  private projectSessionMessages(task: TaskRecord, assistantText: string): void {
    if (
      task.sessionId === null ||
      task.sessionId === undefined ||
      this.dependencies.sessionMessageProjector === undefined
    ) {
      return;
    }
    this.dependencies.sessionMessageProjector.projectTaskExchange({
      assistantText,
      entrySource: resolveTaskEntrySource(task),
      sessionId: task.sessionId,
      taskId: task.taskId,
      userText: task.input
    });
  }

  private buildCompactInput(input: {
    iteration: number;
    messages: ConversationMessage[];
    pendingToolCalls: ProviderToolCall[];
    state: ExecutionLoopState;
    task: TaskRecord;
  }): Parameters<CompactTriggerPolicy["shouldCompact"]>[0] {
    const tokenThreshold =
      this.dependencies.compact.tokenThreshold ??
      computeCompactThreshold(input.state.tokenBudget.inputLimit, this.dependencies.compact.thresholdRatio);
    const previousSummary =
      input.task.sessionId === null || input.task.sessionId === undefined
        ? undefined
        : this.dependencies.sessionSummaryService.findLatestBySession(input.task.sessionId)?.summary;
    return {
      contextWindowTokens: input.state.tokenBudget.inputLimit,
      iteration: input.iteration,
      iterationThreshold: this.dependencies.compact.iterationThreshold,
      maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
      messages: input.messages,
      originalGoal: input.task.input,
      pendingToolCalls: input.pendingToolCalls.map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName
      })),
      ...(previousSummary !== undefined ? { previousSummary } : {}),
      ...(input.state.recentFileReadCache === null
        ? {}
        : {
            recentlyReadFilesSummary: formatRecentlyReadFilesSummary(
              input.state.recentFileReadCache.list()
            )
          }),
      protectFirstN: this.dependencies.compact.protectFirstN,
      protectLastN: this.dependencies.compact.protectLastN,
      sessionScopeKey: input.task.sessionId ?? input.task.taskId,
      targetTokenBudget: Math.floor(input.state.tokenBudget.inputLimit * this.dependencies.compact.targetRatio),
      taskId: input.task.taskId,
      tokenEstimate: computePromptTokens(input.state.tokenCounter, input.messages),
      tokenThreshold,
      toolCallCount: input.state.cumulativeToolCallCount,
      toolCallThreshold: this.dependencies.compact.toolCallThreshold
    };
  }

  private createContextLoopFields(): Pick<
    ExecutionLoopState,
    "compactedCount" | "microPrunedCount" | "recentFileReadCache" | "tokenCounter" | "toolArtifactsRoot"
  > {
    return {
      compactedCount: 0,
      microPrunedCount: 0,
      recentFileReadCache:
        this.dependencies.contextRetention === undefined
          ? null
          : new RecentFileReadCache(this.dependencies.contextRetention),
      tokenCounter: createHybridTokenCounterState(),
      toolArtifactsRoot: join(this.dependencies.workspaceRoot, ".auto-talon", "artifacts")
    };
  }

  private syncRecentFileCacheMode(
    state: ExecutionLoopState,
    pendingToolCalls: ProviderToolCall[],
    availableTools: ProviderToolDescriptor[]
  ): void {
    if (state.recentFileReadCache === null) {
      return;
    }
    const writePending = pendingToolCalls.some((call) => {
      const descriptor = availableTools.find((tool) => tool.name === call.toolName);
      return descriptor?.capability === "filesystem.write";
    });
    state.recentFileReadCache.setMode(writePending ? "write_required" : "normal");
  }

  private async compactMessages(
    input: Parameters<CompactTriggerPolicy["shouldCompact"]>[0],
    manualRequest: ManualCompactRequest | null = null
  ): Promise<SessionCompactResult> {
    const decision =
      manualRequest !== null
        ? { reason: "token_budget" as const, triggered: true }
        : this.dependencies.compactPolicy.shouldCompact(input);
    this.dependencies.traceService.record({
      actor: "runtime.context",
      eventType: "compact_evaluated",
      payload: {
        messageCount: input.messages.length,
        maxMessagesBeforeCompact: input.maxMessagesBeforeCompact,
        reason: decision.reason,
        tokenEstimate: input.tokenEstimate ?? null,
        tokenThreshold: input.tokenThreshold ?? null,
        toolCallCount: input.toolCallCount ?? null,
        toolCallThreshold: input.toolCallThreshold ?? null,
        triggered: decision.triggered
      },
      stage: "memory",
      summary: decision.triggered
        ? `Compaction triggered (${decision.reason ?? "unknown"})`
        : `Compaction skipped (${decision.reason ?? "below_threshold"})`,
      taskId: input.taskId
    });
    if (!decision.triggered) {
      return Promise.resolve({
        reason: null,
        replacementMessages: input.messages.map((message) => mapCompactConversationMessage(message)),
        summaryMemory: null,
        triggered: false
      });
    }

    const messagesToSummarize = input.messages as ConversationMessage[];
    const contextWindowTokens = input.contextWindowTokens ?? input.tokenThreshold ?? 0;
    const summarizer = this.selectCompactSummarizer(
      input.taskId,
      input.sessionScopeKey,
      contextWindowTokens
    );
    let summarized;
    try {
      summarized = await summarizer.summarize({
        maxMessagesBeforeCompact: input.maxMessagesBeforeCompact,
        messages: messagesToSummarize,
        ...(input.originalGoal !== undefined ? { originalGoal: input.originalGoal } : {}),
        ...(input.previousSummary !== undefined ? { previousSummary: input.previousSummary } : {}),
        ...(input.focusTopic !== undefined ? { focusTopic: input.focusTopic } : {}),
        ...(input.recentlyReadFilesSummary !== undefined
          ? { recentlyReadFilesSummary: input.recentlyReadFilesSummary }
          : {}),
        sessionScopeKey: input.sessionScopeKey,
        taskId: input.taskId
      });
    } catch (error) {
      this.dependencies.traceService.record({
        actor: "runtime.context",
        eventType: "compact_summarizer_failed",
        payload: {
          error: error instanceof Error ? error.message : String(error),
          summarizer: this.dependencies.compact.summarizer
        },
        stage: "memory",
        summary: "Session compaction summarizer failed",
        taskId: input.taskId
      });
      throw error;
    }
    const protectedHead = selectHeadMessages(
      messagesToSummarize,
      input.protectFirstN ?? this.dependencies.compact.protectFirstN
    );
    const preservedTail = selectTailMessages(messagesToSummarize, {
      protectLastN: input.protectLastN ?? this.dependencies.compact.protectLastN,
      tailMinMessages: this.dependencies.compact.tailMinMessages,
      tailTokenBudget:
        this.dependencies.compact.tailTokenBudget ??
        input.targetTokenBudget ??
        Math.floor(contextWindowTokens * this.dependencies.compact.targetRatio)
    });
    if (preservedTail.budgetExceeded) {
      this.dependencies.traceService.record({
        actor: "runtime.context",
        eventType: "tail_budget_exceeded",
        payload: {
          protectLastN: input.protectLastN ?? this.dependencies.compact.protectLastN,
          tailMessageCount: preservedTail.messages.length,
          tailTokenBudget:
            this.dependencies.compact.tailTokenBudget ??
            input.targetTokenBudget ??
            Math.floor(contextWindowTokens * this.dependencies.compact.targetRatio),
          usedTokens: preservedTail.usedTokens
        },
        stage: "memory",
        summary: "Protected tail messages exceed tail token budget",
        taskId: input.taskId
      });
    }
    const preservedMessages = mergeProtectedMessages(protectedHead, preservedTail.messages);
    const protectedHeadCount = Math.min(protectedHead.length, preservedMessages.length);
    const preserved = preservedMessages.map((message) => mapCompactConversationMessage(message));
    const discardedMessages = listDiscardedMessages(messagesToSummarize, preservedMessages);

    return {
      reason:
        decision.reason === "token_budget" ||
        decision.reason === "tool_call_count" ||
        decision.reason === "iteration_count"
          ? decision.reason
          : "message_count",
      replacementMessages: [
        ...preserved.slice(0, protectedHeadCount),
        {
          content: buildSessionHandoffMessageContent({
            compactedMessages: discardedMessages,
            summary: summarized.summary
          }),
          role: "system"
        },
        ...preserved.slice(protectedHeadCount)
      ],
      summaryMemory: null,
      triggered: true
    };
  }

  private createAuxiliaryFailoverProvider(
    provider: Provider,
    input: { sessionId: string | null; slot: string; taskId: string }
  ): Provider {
    void input.sessionId;
    return {
      capabilities: provider.capabilities,
      describe: provider.describe?.bind(provider),
      fetchContextWindow: provider.fetchContextWindow?.bind(provider),
      generate: (request) =>
        generateWithProviderFailover(
          {
            auditService: this.dependencies.auditService,
            auxiliarySlot: input.slot,
            cwd: this.dependencies.workspaceRoot,
            enableFailover: true,
            primaryProvider: provider,
            taskId: input.taskId,
            traceService: this.dependencies.traceService
          },
          request
        ),
      getStats: provider.getStats?.bind(provider),
      model: provider.model,
      name: provider.name,
      streamGenerate: provider.streamGenerate?.bind(provider),
      testConnection: provider.testConnection?.bind(provider)
    };
  }
  private selectCompactSummarizer(
    taskId: string,
    sessionId: string | null,
    mainContextWindowTokens: number
  ): CompactSummarizer {
    if (this.dependencies.compact.summarizer !== "provider_subagent") {
      return new DeterministicCompactSummarizer();
    }
    const helperProvider =
      this.dependencies.auxiliaryProviderResolver?.resolve("compression", {
        sessionId,
        taskId
      }) ??
      this.dependencies.providerRouter?.selectProvider({
        kind: "summarize",
        taskId,
        sessionId
      }).provider ??
      this.dependencies.provider;
    const helperContextWindow =
      helperProvider.describe?.().contextWindowTokens ?? Math.min(mainContextWindowTokens, 32_000);
    const failoverHelperProvider = this.createAuxiliaryFailoverProvider(helperProvider, {
      sessionId,
      slot: "compression",
      taskId
    });
    return new ProviderSubagentSummarizer(
      (context) => {
        if (context.kind !== "summarize") {
          return null;
        }
        return failoverHelperProvider;
      },
      { maxInputTokens: helperContextWindow }
    );
  }

  private finalizeTaskFailure(
    task: TaskRecord,
    error: AppError,
    onTaskEvent?: (event: RuntimeTaskEvent) => void
  ): AppError {
    const isCancelled = error.code === "interrupt";

    if (error.code === "interrupt" || error.code === "timeout") {
      this.dependencies.traceService.record({
        actor: "runtime.kernel",
        eventType: "interrupt",
        payload: {
          iteration: task.currentIteration,
          reason: error.message
        },
        stage: "control",
        summary: `Task interrupted with ${error.code}`,
        taskId: task.taskId
      });
    }

    this.checkpointManager.delete(task.taskId);
    this.dependencies.taskRepository.update(task.taskId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status: isCancelled ? "cancelled" : "failed"
    });
    emitTaskEvent(onTaskEvent, {
      errorCode: error.code,
      errorMessage: error.message,
      kind: "result",
      outputPreview: null,
      status: isCancelled ? "cancelled" : "failed",
      taskId: task.taskId
    });

    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "final_outcome",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        output: null,
        status: isCancelled ? "cancelled" : "failed"
      },
      stage: "completion",
      summary: "Task finished with an error",
      taskId: task.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "task_failure",
      payload: {
        cwd: task.cwd,
        errorCode: error.code,
        errorMessage: error.message,
        status: isCancelled ? "cancelled" : "failed"
      },
      stage: "lifecycle",
      summary: "Task failure lifecycle hook published",
      taskId: task.taskId
    });
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "session_end",
      payload: {
        status: isCancelled ? "cancelled" : "failed",
        summary: error.message
      },
      stage: "lifecycle",
      summary: "Session end lifecycle hook published",
      taskId: task.taskId
    });

    this.persistSessionTask(task, task.input, {
      errorCode: error.code,
      errorMessage: error.message,
      status: isCancelled ? "cancelled" : "failed"
    });

    const updatedTask = this.dependencies.taskRepository.findById(task.taskId) ?? task;
    this.projectSessionMessages(updatedTask, error.message);

    return new AppError({
      cause: error,
      code: error.code,
      details: {
        ...(error.details ?? {}),
        taskId: task.taskId
      },
      message: error.message
    });
  }

  private persistSessionTask(
    task: TaskRecord,
    input: string,
    summary: {
      status: TaskRecord["status"];
      finalOutput?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): void {
    if (task.sessionId === null || task.sessionId === undefined) {
      return;
    }
    if (this.dependencies.sessionTaskRepository.findByTaskId(task.taskId) !== null) {
      return;
    }
    this.dependencies.sessionTaskRepository.create({
      createdAt: task.startedAt ?? task.createdAt,
      finishedAt: task.finishedAt,
      input,
      metadata: {
        providerName: task.providerName
      },
      runId: randomUUID(),
      status: task.status,
      summary: {
        errorCode: summary.errorCode ?? null,
        errorMessage: summary.errorMessage ?? null,
        finalOutput: summary.finalOutput ?? task.finalOutput ?? null,
        status: summary.status
      },
      taskId: task.taskId,
      sessionId: task.sessionId
    });
  }

  private async executeParallelToolBatch(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    pendingToolCalls: ProviderToolCall[],
    batchCalls: ProviderToolCall[],
    batchStartIndex: number,
    task: TaskRecord,
    iteration: number
  ): Promise<{ kind: "done"; toolCallCount: number } | { kind: "paused"; result: RuntimeRunResult }> {
    const clearedCalls: ProviderToolCall[] = [];
    const preflightOutcomes: Array<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> = [];

    for (let batchOffset = 0; batchOffset < batchCalls.length; batchOffset += 1) {
      const toolCall = batchCalls[batchOffset];
      if (toolCall === undefined) {
        continue;
      }
      const invocation = await this.preflightToolCall(state, task, iteration, toolCall);
      const paused = this.tryPauseToolExecution(
        state,
        messages,
        pendingToolCalls,
        batchStartIndex + batchOffset,
        task,
        iteration,
        invocation
      );
      if (paused !== null) {
        for (const prior of preflightOutcomes) {
          if (prior.outcome.kind === "completed") {
            this.applyCompletedToolCallOutcome(
              state,
              messages,
              task,
              iteration,
              prior.toolCall,
              prior.outcome
            );
          }
        }
        return { kind: "paused", result: paused };
      }
      if (invocation.outcome.kind === "completed") {
        this.applyCompletedToolCallOutcome(
          state,
          messages,
          task,
          iteration,
          invocation.toolCall,
          invocation.outcome
        );
        preflightOutcomes.push(invocation);
        continue;
      }
      if (invocation.outcome.kind === "cleared") {
        clearedCalls.push(toolCall);
        continue;
      }
    }

    if (clearedCalls.length === 0) {
      return { kind: "done", toolCallCount: preflightOutcomes.length };
    }

    const batchInvocations = await Promise.all(
      clearedCalls.map(async (toolCall) => {
        const replayed = this.tryApplyDuplicateToolReplay(state, messages, task, iteration, toolCall);
        if (replayed) {
          return null;
        }
        return this.invokeToolCall(state, task, iteration, toolCall);
      })
    );

    let toolCallCount = preflightOutcomes.length;
    for (let batchOffset = 0; batchOffset < batchInvocations.length; batchOffset += 1) {
      const invocation = batchInvocations[batchOffset];
      if (invocation === null || invocation === undefined) {
        if (invocation === null) {
          toolCallCount += 1;
        }
        continue;
      }
      const paused = this.tryPauseToolExecution(
        state,
        messages,
        pendingToolCalls,
        batchStartIndex + clearedCalls.findIndex((call) => call.toolCallId === invocation.toolCall.toolCallId),
        task,
        iteration,
        invocation
      );
      if (paused !== null) {
        for (let priorOffset = 0; priorOffset < batchOffset; priorOffset += 1) {
          const priorInvocation = batchInvocations[priorOffset];
          if (priorInvocation === null || priorInvocation === undefined) {
            continue;
          }
          this.applyCompletedToolCallOutcome(
            state,
            messages,
            task,
            iteration,
            priorInvocation.toolCall,
            priorInvocation.outcome
          );
          toolCallCount += 1;
        }
        return { kind: "paused", result: paused };
      }
      this.applyCompletedToolCallOutcome(
        state,
        messages,
        task,
        iteration,
        invocation.toolCall,
        invocation.outcome
      );
      toolCallCount += 1;
    }

    return { kind: "done", toolCallCount };
  }

  private async preflightToolCall(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): Promise<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> {
    const replayOutcome = this.resolveDuplicateToolReplay(state, toolCall);
    if (replayOutcome !== null) {
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "started",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.recordDuplicateToolReplayTrace(state, task, iteration, toolCall, replayOutcome);
      return { outcome: replayOutcome, toolCall };
    }

    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: "started",
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
    state.managedAbortController.touchActivity("tool_call_preflight");

    const outcome = await this.dependencies.toolOrchestrator.execute(
      {
        input: toolCall.input,
        iteration,
        reason: toolCall.reason,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      },
      {
        agentProfileId: task.agentProfileId,
        cwd: state.cwd,
        governanceOnly: true,
        iteration,
        signal: state.managedAbortController.abortController.signal,
        taskId: task.taskId,
        taskMetadata: buildToolTaskMetadata(task),
        userId: task.requesterUserId,
        workspaceRoot: this.dependencies.workspaceRoot
      }
    );
    state.managedAbortController.touchActivity(`tool_call_preflight_${outcome.kind}`);

    return { outcome, toolCall };
  }

  private async invokeToolCall(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): Promise<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> {
    const replayOutcome = this.resolveDuplicateToolReplay(state, toolCall);
    if (replayOutcome !== null) {
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "started",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.recordDuplicateToolReplayTrace(state, task, iteration, toolCall, replayOutcome);
      return { outcome: replayOutcome, toolCall };
    }

    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: "started",
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
    state.managedAbortController.touchActivity("tool_call_started");

    const outcome = await this.dependencies.toolOrchestrator.execute(
      {
        input: toolCall.input,
        iteration,
        reason: toolCall.reason,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      },
      {
        agentProfileId: task.agentProfileId,
        cwd: state.cwd,
        iteration,
        signal: state.managedAbortController.abortController.signal,
        taskId: task.taskId,
        taskMetadata: buildToolTaskMetadata(task),
        userId: task.requesterUserId,
        workspaceRoot: this.dependencies.workspaceRoot
      }
    );
    state.managedAbortController.touchActivity(`tool_call_${outcome.kind}`);

    return { outcome, toolCall };
  }

  private tryPauseToolExecution(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    pendingToolCalls: ProviderToolCall[],
    checkpointIndex: number,
    task: TaskRecord,
    iteration: number,
    invocation: { outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }
  ): RuntimeRunResult | null {
    const { outcome, toolCall } = invocation;

    if (outcome.kind === "approval_required") {
      task = this.dependencies.taskRepository.update(task.taskId, {
        status: "waiting_approval"
      });

      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "approval_required",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.checkpointManager.save({
        iteration,
        memoryContext: state.memoryContext,
        messages,
        pendingToolCalls: pendingToolCalls.slice(checkpointIndex),
        pendingClarifyPromptId: null,
        taskId: task.taskId
      });

      return {
        output: null,
        task
      };
    }

    if (outcome.kind === "clarify_required") {
      task = this.dependencies.taskRepository.update(task.taskId, {
        status: "waiting_clarification"
      });

      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "clarify_required",
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      this.checkpointManager.save({
        iteration,
        memoryContext: state.memoryContext,
        messages,
        pendingClarifyPromptId: outcome.prompt.promptId,
        pendingToolCalls: pendingToolCalls.slice(checkpointIndex),
        taskId: task.taskId
      });

      return {
        output: null,
        task
      };
    }

    return null;
  }

  private applyCompletedToolCallOutcome(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall,
    outcome: ToolExecutionOutcome
  ): void {
    if (outcome.kind !== "completed") {
      const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
      const privacyLevel = toolDescriptor?.privacyLevel ?? "internal";
      if (toolDescriptor?.capability !== "interaction.ask_user") {
        messages.push(
          createToolFeedbackMessage(
            {
              error: `Tool execution did not complete (${outcome.kind}).`,
              errorCode: `tool_${outcome.kind}`,
              recoverable: true
            },
            toolCall,
            privacyLevel
          )
        );
      }
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: "failed",
        summary: `Tool ${toolCall.toolName} ended with ${outcome.kind}`,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      return;
    }

    state.cumulativeToolCallCount += 1;
    const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
    const writeToolResult =
      toolDescriptor?.capability === "filesystem.write" || toolCall.toolName.includes("write");
    if (
      outcome.result.success &&
      outcome.result.replayed !== true &&
      writeToolResult
    ) {
      state.writeToolSucceeded = true;
      state.completionVerificationSatisfied = false;
    }
    if (isSuccessfulVerificationToolExecution(toolCall.toolName, outcome.result)) {
      state.completionVerificationSatisfied = true;
      if (!state.completionVerificationSatisfiedEmitted) {
        this.dependencies.traceService.record({
          actor: "runtime.kernel",
          eventType: "completion_verification_satisfied",
          payload: {
            iteration,
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName
          },
          stage: "completion",
          summary: "Completion verification evidence recorded",
          taskId: task.taskId
        });
        state.completionVerificationSatisfiedEmitted = true;
      }
    }
    const toolResultOutput = toolResultOutputForModel(outcome.result);
    if (state.recentFileReadCache !== null && outcome.result.success) {
      recordRecentFileReadFromToolCall(
        state.recentFileReadCache,
        toolCall.toolName,
        toolCall.input as { path?: unknown },
        toolResultOutput,
        toolCall.toolCallId
      );
    }
    const toolSummary = toolResultSummary(outcome.result, toolCall.toolName);
    const structuredOutputSummary = summarizeToolOutput(toolResultOutput);
    const isDeduplicatable =
      toolDescriptor !== null &&
      (toolDescriptor.capability === "filesystem.read" ||
        toolDescriptor.capability === "network.fetch_public_readonly");
    const signature = isDeduplicatable
      ? toolCallSignature(toolCall.toolName, toolCall.input)
      : null;
    const priorCall =
      signature === null ? null : state.toolCallSignatures.get(signature) ?? null;
    const duplicateNotice =
      priorCall === null
        ? null
        : `NOTE: duplicate tool call. You already invoked ${toolCall.toolName} with identical arguments at iteration ${priorCall.iteration} (call ${priorCall.toolCallId}). Do not call this tool again with the same arguments - synthesize from the prior result and answer the user.`;
    const finishedSummary =
      priorCall === null
        ? `${toolSummary} | ${structuredOutputSummary}`
        : `${toolSummary} | ${structuredOutputSummary} (duplicate of iter ${priorCall.iteration})`;
    const privacyLevel = toolDescriptor?.privacyLevel ?? "internal";

    if (toolDescriptor !== null) {
      if (toolDescriptor.capability !== "interaction.ask_user") {
        const feedbackMessage = this.buildToolFeedbackMessage(
          state,
          task,
          toolCall,
          toolResultOutput,
          privacyLevel,
          duplicateNotice
        );
        messages.push(feedbackMessage);
        if (signature !== null && priorCall === null) {
          state.toolCallSignatures.set(signature, {
            cachedToolOutput: safeSerializeToolOutputForBudget(toolResultOutput),
            iteration,
            toolCallId: toolCall.toolCallId
          });
        }
      }
      if (signature !== null && priorCall === null && toolDescriptor.capability === "interaction.ask_user") {
        state.toolCallSignatures.set(signature, {
          iteration,
          toolCallId: toolCall.toolCallId
        });
      }
      emitTaskEvent(state.onTaskEvent, {
        iteration,
        kind: "tool",
        status: outcome.result.success ? "finished" : "failed",
        summary: finishedSummary,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      });
      return;
    }
    const feedbackMessage = this.buildToolFeedbackMessage(
      state,
      task,
      toolCall,
      toolResultOutput,
      privacyLevel,
      duplicateNotice
    );
    messages.push(feedbackMessage);
    if (signature !== null && priorCall === null) {
      state.toolCallSignatures.set(signature, {
        cachedToolOutput: safeSerializeToolOutputForBudget(toolResultOutput),
        iteration,
        toolCallId: toolCall.toolCallId
      });
    }
    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: outcome.result.success ? "finished" : "failed",
      summary: finishedSummary,
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
  }

  private tryApplyDuplicateToolReplay(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): boolean {
    const replayOutcome = this.resolveDuplicateToolReplay(state, toolCall);
    if (replayOutcome === null) {
      return false;
    }

    emitTaskEvent(state.onTaskEvent, {
      iteration,
      kind: "tool",
      status: "started",
      taskId: task.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName
    });
    this.applyCompletedToolCallOutcome(
      state,
      messages,
      task,
      iteration,
      toolCall,
      replayOutcome
    );
    this.recordDuplicateToolReplayTrace(state, task, iteration, toolCall, replayOutcome);
    return true;
  }

  private resolveDuplicateToolReplay(
    state: ExecutionLoopState,
    toolCall: ProviderToolCall
  ): Extract<ToolExecutionOutcome, { kind: "completed" }> | null {
    const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
    const isDeduplicatable =
      toolDescriptor !== null &&
      (toolDescriptor.capability === "filesystem.read" ||
        toolDescriptor.capability === "network.fetch_public_readonly");
    if (!isDeduplicatable) {
      return null;
    }
    const signature = toolCallSignature(toolCall.toolName, toolCall.input);
    const priorCall = state.toolCallSignatures.get(signature);
    if (priorCall === undefined || priorCall.cachedToolOutput === undefined) {
      return null;
    }

    let parsedOutput: unknown = priorCall.cachedToolOutput;
    try {
      parsedOutput = JSON.parse(priorCall.cachedToolOutput);
    } catch {
      parsedOutput = priorCall.cachedToolOutput;
    }

    return {
      kind: "completed",
      result: {
        output: parsedOutput as JsonValue,
        replayed: true,
        success: true,
        summary: `Tool ${toolCall.toolName} replayed from duplicate cache`
      },
      toolCall: {
        errorCode: null,
        errorMessage: null,
        finishedAt: new Date().toISOString(),
        input: toolCall.input,
        iteration: state.task.currentIteration,
        output: parsedOutput as JsonValue,
        requestedAt: new Date().toISOString(),
        riskLevel: toolDescriptor?.riskLevel ?? "low",
        startedAt: new Date().toISOString(),
        status: "finished",
        summary: `Tool ${toolCall.toolName} replayed from duplicate cache`,
        taskId: state.task.taskId,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      }
    };
  }

  private recordDuplicateToolReplayTrace(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall,
    replayOutcome: Extract<ToolExecutionOutcome, { kind: "completed" }>
  ): void {
    const signature = toolCallSignature(toolCall.toolName, toolCall.input);
    const priorCall = state.toolCallSignatures.get(signature);
    this.dependencies.traceService.record({
      actor: "runtime.kernel",
      eventType: "duplicate_tool_replayed",
      payload: {
        iteration,
        priorIteration: priorCall?.iteration ?? null,
        priorToolCallId: priorCall?.toolCallId ?? null,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName
      },
      stage: "tooling",
      summary: `Replayed duplicate ${toolCall.toolName} from iteration ${priorCall?.iteration ?? "unknown"}`,
      taskId: task.taskId
    });
    void replayOutcome;
    void state;
  }

  private buildToolFeedbackMessage(
    state: ExecutionLoopState,
    task: TaskRecord,
    toolCall: ProviderToolCall,
    toolResultOutput: unknown,
    privacyLevel: "public" | "internal" | "restricted",
    duplicateNotice: string | null
  ): ConversationMessage {
    const serialized = safeSerializeToolOutputForBudget(toolResultOutput);
    const maxTokens = this.dependencies.contextRetention?.toolOutputMaxTokens ?? 2_500;
    const budgeted = applyToolOutputBudget(
      {
        serialized,
        taskId: task.taskId,
        toolCallId: toolCall.toolCallId
      },
      {
        artifactsRoot: state.toolArtifactsRoot,
        maxTokensPerResult: maxTokens
      }
    );
    const base = createToolFeedbackMessage(
      toolResultOutput,
      toolCall,
      privacyLevel,
      budgeted.content
    );
    if (duplicateNotice === null) {
      return base;
    }
    return {
      ...base,
      content: `${duplicateNotice}\n\n${base.content}`
    };
  }

  private appendSessionTranscript(
    task: TaskRecord,
    event: {
      content: string | null;
      eventType: Parameters<SessionTranscriptRepository["append"]>[0]["eventType"];
      payload?: Parameters<SessionTranscriptRepository["append"]>[0]["payload"];
      role: Parameters<SessionTranscriptRepository["append"]>[0]["role"];
    }
  ): void {
    if (task.sessionId === null || task.sessionId === undefined) {
      return;
    }
    this.dependencies.sessionTranscriptRepository.append({
      content: event.content,
      eventType: event.eventType,
      payload: event.payload ?? {},
      role: event.role ?? null,
      sessionId: task.sessionId,
      taskId: task.taskId
    });
  }

  private emitOutput(draft: Parameters<RuntimeOutputService["record"]>[0]): RuntimeOutputEvent {
    return this.dependencies.outputService.record(draft);
  }

  private buildExplicitSkillMetadata(input: string): Record<string, unknown> {
    const activations = this.dependencies.skillContextService?.resolveExplicitSkillActivations(input) ?? [];
    if (activations.length === 0) {
      return {};
    }
    const allowedTools = intersectNonEmpty(activations.map((activation) => activation.allowedTools));
    const disallowedTools = uniqueStringsFromArrays(
      activations.map((activation) => activation.disallowedTools)
    );
    const forkedSkills = activations
      .filter((activation) => activation.context === "fork" && activation.agent !== null)
      .map((activation) => ({
        agent: activation.agent,
        skillId: activation.skillId
      }));
    return {
      activeSkills: activations.map((activation) => ({
        arguments: activation.arguments,
        skillId: activation.skillId
      })),
      ...(allowedTools.length > 0 || disallowedTools.length > 0
        ? {
            activeSkillToolConstraints: {
              ...(allowedTools.length > 0 ? { allowedTools } : {}),
              ...(disallowedTools.length > 0 ? { disallowedTools } : {})
            }
          }
        : {}),
      ...(forkedSkills.length > 0 ? { activeForkedSkills: forkedSkills } : {})
    };
  }
}

function intersectNonEmpty(groups: string[][]): string[] {
  const nonEmpty = groups.filter((group) => group.length > 0);
  if (nonEmpty.length === 0) {
    return [];
  }
  const [first, ...rest] = nonEmpty;
  if (first === undefined) {
    return [];
  }
  return uniqueStrings(first).filter((tool) => rest.every((group) => group.includes(tool)));
}

function uniqueStringsFromArrays(groups: string[][]): string[] {
  return uniqueStrings(groups.flat());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function formatWorkflowTestCommandHints(
  commands: WorkflowRuntimeConfig["testCommands"]
): string[] {
  return commands.map((command) => (typeof command === "string" ? command : command.command));
}

function toolResultOutputForModel(result: ToolExecutionResult): unknown {
  if (result.success) {
    return result.output;
  }
  return {
    error: result.errorMessage,
    errorCode: result.errorCode,
    recoverable: true,
    ...(result.details === undefined ? {} : { details: result.details })
  };
}

function toolResultSummary(result: ToolExecutionResult, toolName: string): string {
  return result.success
    ? result.summary
    : `Tool ${toolName} failed: ${result.errorMessage}`;
}

function resolveTaskEntrySource(task: TaskRecord): SessionEntrySource {
  const gateway = task.metadata?.gateway;
  if (gateway !== null && gateway !== undefined && typeof gateway === "object") {
    const adapterId = (gateway as { adapterId?: unknown }).adapterId;
    if (typeof adapterId === "string" && adapterId.length > 0) {
      return "gateway";
    }
  }
  const source = task.metadata?.source;
  if (source === "tui" || source === "cli" || source === "schedule" || source === "gateway") {
    return source;
  }
  return "cli";
}

function readInteractionModeFromMetadata(metadata: Record<string, unknown> | undefined): RuntimeRunOptions["interactionMode"] {
  if (metadata?.interactionMode === "plan") {
    return "plan";
  }
  if (metadata?.interactionMode === "acceptEdits") {
    return "acceptEdits";
  }
  return "agent";
}

function buildToolTaskMetadata(task: TaskRecord): TaskRecord["metadata"] {
  return {
    ...task.metadata,
    ...(task.sessionId !== null && task.sessionId !== undefined ? { sessionId: task.sessionId } : {})
  };
}

function mapCompactConversationMessage(message: {
  role: string;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string }>;
  metadata?: ConversationMessage["metadata"];
}): ConversationMessage {
  const mapped: ConversationMessage = {
    content: message.content,
    role: toConversationRole(message.role)
  };
  if (message.toolCallId !== undefined) {
    mapped.toolCallId = message.toolCallId;
  }
  if (message.toolName !== undefined) {
    mapped.toolName = message.toolName;
  }
  if (message.toolCalls !== undefined) {
    mapped.toolCalls = message.toolCalls as ProviderToolCall[];
  }
  if (message.metadata !== undefined) {
    mapped.metadata = message.metadata;
  }
  return mapped;
}

function selectHeadMessages(messages: ConversationMessage[], protectFirstN: number): ConversationMessage[] {
  if (protectFirstN <= 0) {
    return [];
  }
  const selected: ConversationMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    selected.push(message);
    if (selected.length >= protectFirstN) {
      break;
    }
  }
  return selected;
}

function mergeProtectedMessages(
  head: ConversationMessage[],
  tail: ConversationMessage[]
): ConversationMessage[] {
  const merged: ConversationMessage[] = [];
  const seen = new Set<string>();
  for (const message of [...head, ...tail]) {
    const key = compactMessageIdentity(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

function compactMessageIdentity(message: ConversationMessage): string {
  const toolCalls = message.toolCalls?.map((call) => call.toolCallId).join(",") ?? "";
  return [
    message.role,
    message.toolCallId ?? "",
    message.toolName ?? "",
    toolCalls,
    message.content
  ].join("\u0000");
}

function buildToolExposurePlannerInput(input: {
  context: ToolExposurePlannerInput["context"];
  interactionMode: RuntimeRunOptions["interactionMode"];
  iteration: number;
  taskId: string;
  sessionId: string | null;
}): ToolExposurePlannerInput {
  const plannerInput: ToolExposurePlannerInput = {
    context: input.context,
    iteration: input.iteration,
    sessionId: input.sessionId,
    taskId: input.taskId
  };
  if (input.interactionMode !== undefined) {
    plannerInput.interactionMode = input.interactionMode;
  }
  return plannerInput;
}

