import { randomUUID } from "node:crypto";

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
  createToolFeedbackMessageWithNotice,
  emitTaskEvent,
  estimateTokenCount,
  injectResumeContextMessages,
  normalizeProviderFailure,
  providerUsageToJson,
  readSessionResumeMemoryContext,
  readSessionResumeMessages,
  rebuildTurnProviderMessages,
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
import type { ContextRetentionConfig } from "./context/recent-file-reads.js";
import type { ContextCompactor, SessionSummaryService } from "./context/index.js";
import type { RecallPlanner } from "./retrieval/index.js";
import type { RetrievalWorker, SummarizerWorker, WorkerDispatcher } from "./workers/index.js";
import type { RuntimeConfig, WorkflowRuntimeConfig } from "./runtime-config.js";
import type { ToolExposurePlanner } from "./tool-exposure-planner.js";
import type { ProviderRouter } from "../providers/routing/provider-router.js";
import type { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
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
  BudgetPricingEntry
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

export interface ExecutionKernelDependencies {
  agentProfileRegistry: AgentProfileRegistry;
  compactPolicy: CompactTriggerPolicy;
  executionCheckpointRepository: ExecutionCheckpointRepository;
  getSessionCommitmentState?: (sessionId: string) => SessionCommitmentState | null;
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
  workspaceRoot: string;
}

interface ExecutionLoopState {
  costWarnedToolNames: string[];
  cumulativeToolCallCount: number;
  cwd: string;
  managedAbortController: ReturnType<typeof createManagedAbortController>;
  maxIterations: number;
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
  postCompletionVerificationReads: number;
  selectedSkillContext: ContextFragment[];
  silentToolTurns: number;
  toolCallSignatures: Map<string, { iteration: number; toolCallId: string }>;
  turnFilteredFragments: ContextAssemblyDebugView["filteredOutFragments"];
  turnProviderMessages: ConversationMessage[];
  repoMapSummary?: string;
  task: TaskRecord;
  tokenBudget: TokenBudget;
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
      recordTrace: (event) => dependencies.traceService.record(event)
    });
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
    const taskMetadata = options.metadata ?? {};
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
        ? await this.dependencies.toolExposurePlanner.plan({
            context: {
              agentProfileId: options.agentProfileId,
              cwd: options.cwd,
              iteration: 1,
              signal: managedAbortController.abortController.signal,
              taskId,
              taskMetadata: task.metadata,
              userId: options.userId,
              workspaceRoot: this.dependencies.workspaceRoot
            },
            iteration: 1,
            taskId,
            sessionId
          })
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
        repoMap?.summary
      );
      const resumeContextMessages = readSessionResumeMessages(taskMetadata);
      if (resumeContextMessages.length > 0) {
        injectResumeContextMessages(messages, resumeContextMessages);
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
        cwd: options.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
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
        cwd: resumedTask.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        completionVerificationGuardEmitted: false,
        completionVerificationSatisfied: false,
        completionVerificationSatisfiedEmitted: false,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
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
          const exposure = await this.dependencies.toolExposurePlanner.plan({
            context: {
              agentProfileId: state.task.agentProfileId,
              cwd: state.cwd,
              iteration,
              signal: state.managedAbortController.abortController.signal,
              taskId: task.taskId,
              taskMetadata: task.metadata,
              userId: task.requesterUserId,
              workspaceRoot: this.dependencies.workspaceRoot
            },
            iteration,
            taskId: task.taskId,
            sessionId: task.sessionId ?? null
          });
          availableTools = exposure.tools;
          state.costWarnedToolNames = exposure.decisions
            .filter((decision) => decision.costWarning === true)
            .map((decision) => decision.toolName);
          state.managedAbortController.touchActivity("tool_exposure_planned");
        } else {
          availableTools = baseAvailableTools;
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
            debugView: assembled.debug,
            iteration
          },
          stage: "planning",
          summary: `Context assembled with ${assembled.debug.memoryRecallFragments.length} recall fragments`,
          taskId: task.taskId
        });

        const activeProvider =
          this.dependencies.providerRouter?.selectProvider({
            kind: "main",
            taskId: task.taskId,
            sessionId: task.sessionId ?? null,
            ...(this.dependencies.routingMode !== undefined
              ? { mode: this.dependencies.routingMode }
              : {})
          }).provider ?? this.dependencies.provider;

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
        try {
          providerResponse = await activeProvider.generate(providerInput);
        } catch (error) {
          const providerError = normalizeProviderFailure(error, activeProvider);
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
        state.managedAbortController.touchActivity("provider_request_succeeded");
        const assistantDisplay = providerResponse.kind === "final" ? "final" : "intermediate";
        const transcriptVisibility =
          providerResponse.kind === "tool_calls" ? "hidden" : "visible";

        messages.push({
          content: providerResponse.message,
          role: "assistant",
          ...(providerResponse.metadata?.raw !== undefined
            ? { metadata: providerResponse.metadata.raw }
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

        if (providerResponse.kind === "tool_calls") {
          this.completionController.observeProviderToolTurn(state, messages, iteration, providerResponse);
        }

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
                ? providerResponse.toolCalls.map((call) => call.toolName)
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

        if (!isParallelSafe(pendingToolCalls[toolCallIndex].toolName)) {
          const toolCall = pendingToolCalls[toolCallIndex];
          const invocation = await this.invokeToolCall(state, task, iteration, toolCall);
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
        while (
          toolCallIndex < pendingToolCalls.length &&
          isParallelSafe(pendingToolCalls[toolCallIndex].toolName)
        ) {
          batchCalls.push(pendingToolCalls[toolCallIndex]);
          toolCallIndex += 1;
        }

        const batchInvocations = await Promise.all(
          batchCalls.map((toolCall) => this.invokeToolCall(state, task, iteration, toolCall))
        );

        for (let batchOffset = 0; batchOffset < batchInvocations.length; batchOffset += 1) {
          const invocation = batchInvocations[batchOffset];
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
            for (let priorOffset = 0; priorOffset < batchOffset; priorOffset += 1) {
              const priorInvocation = batchInvocations[priorOffset];
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
        }
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
      const compacted = await this.compactMessages({
        iteration,
        iterationThreshold: this.dependencies.compact.iterationThreshold,
        maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
        messages,
        originalGoal: task.input,
        pendingToolCalls,
        sessionScopeKey: task.sessionId ?? task.taskId,
        taskId: task.taskId,
        tokenEstimate: estimateTokenCount(messages),
        tokenThreshold: this.dependencies.compact.tokenThreshold,
        toolCallCount: state.cumulativeToolCallCount,
        toolCallThreshold: this.dependencies.compact.toolCallThreshold
      });
      if (compacted.triggered) {
        const compactReason = compacted.reason ?? "message_count";
        const preCompactMessages = [...messages];
        if (task.sessionId !== null && task.sessionId !== undefined) {
          const latestRun = this.dependencies.sessionTaskRepository.findLatestBySessionId(task.sessionId);
          this.dependencies.sessionLineageRepository.append({
            eventType: "compress",
            lineageId: randomUUID(),
            payload: {
              messageCount: messages.length,
              reason: compactReason
            },
            sourceRunId: latestRun?.runId ?? null,
            targetRunId: latestRun?.runId ?? null,
            sessionId: task.sessionId
          });
          const compactInput = {
            iteration,
            iterationThreshold: this.dependencies.compact.iterationThreshold,
            maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
            messages: preCompactMessages,
            originalGoal: task.input,
            pendingToolCalls,
            reason: compactReason,
            sessionScopeKey: task.sessionId,
            taskId: task.taskId,
            tokenEstimate: estimateTokenCount(preCompactMessages),
            tokenThreshold: this.dependencies.compact.tokenThreshold,
            toolCallCount: state.cumulativeToolCallCount,
            toolCallThreshold: this.dependencies.compact.toolCallThreshold
          } as const;
          const workerDispatcher = this.dependencies.workerDispatcher;
          const summarizerWorker = this.dependencies.summarizerWorker;
          if (workerDispatcher !== undefined && summarizerWorker !== undefined) {
            await workerDispatcher.dispatch(
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
                sessionId: task.sessionId,
                timeoutMs: 5_000,
                workerId: randomUUID(),
                workerKind: "summarizer"
              },
              (input) => summarizerWorker.execute(input)
            );
          } else {
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
              sessionId: task.sessionId,
              trigger: "compact"
            });
          }
        }
        const initialSystemPrompt =
          messages.find((message) => message.role === "system") ?? null;
        messages.length = 0;
        state.toolCallSignatures.clear();
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
    const activeProvider =
      this.dependencies.providerRouter?.selectProvider({
        kind: "main",
        taskId: task.taskId,
        sessionId: task.sessionId ?? null,
        ...(this.dependencies.routingMode !== undefined
          ? { mode: this.dependencies.routingMode }
          : {})
      }).provider ?? this.dependencies.provider;
    const summaryPrompt =
      reason === "max_iterations_exhausted"
        ? `The loop reached its iteration budget (${state.maxIterations}). Do not call tools. Summarize the completed work, files changed or inspected, and any remaining work.`
        : "The task appears complete and further verification reads are no longer useful. Do not call tools. Provide the final answer now with completed work and any remaining notes.";
    const finalMessages: ConversationMessage[] = [
      ...state.turnProviderMessages,
      ...messages.filter((message) => message.role === "tool").slice(-6),
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
      providerResponse = await activeProvider.generate({
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
      });
    } catch {
      throw new AppError({
        code: "max_rounds_exceeded",
        message: `Task exceeded ${state.maxIterations} iterations.`
      });
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

  private async compactMessages(
    input: Parameters<CompactTriggerPolicy["shouldCompact"]>[0]
  ): Promise<SessionCompactResult> {
    const decision = this.dependencies.compactPolicy.shouldCompact(input);
    if (!decision.triggered) {
      return Promise.resolve({
        reason: null,
        replacementMessages: input.messages.map((message) => ({
          content: message.content,
          role: toConversationRole(message.role),
          ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
          ...(message.toolName !== undefined ? { toolName: message.toolName } : {})
        })),
        summaryMemory: null,
        triggered: false
      });
    }

    const messagesToSummarize = input.messages as ConversationMessage[];
    const summarizer = this.selectCompactSummarizer(input.taskId, input.sessionScopeKey);
    const summarized = await summarizer.summarize({
      maxMessagesBeforeCompact: input.maxMessagesBeforeCompact,
      messages: messagesToSummarize,
      ...(input.originalGoal !== undefined ? { originalGoal: input.originalGoal } : {}),
      sessionScopeKey: input.sessionScopeKey,
      taskId: input.taskId
    });
    const preserved = messagesToSummarize.slice(-3).map((message) => ({
      content: message.content,
      role: toConversationRole(message.role),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {})
    }));

    return {
      reason:
        decision.reason === "token_budget" ||
        decision.reason === "tool_call_count" ||
        decision.reason === "iteration_count"
          ? decision.reason
          : "message_count",
      replacementMessages: [
        {
          content: `Session summary:\n${summarized.summary}`,
          role: "system"
        },
        ...preserved
      ],
      summaryMemory: null,
      triggered: true
    };
  }

  private selectCompactSummarizer(taskId: string, sessionId: string | null): CompactSummarizer {
    if (this.dependencies.compact.summarizer !== "provider_subagent") {
      return new DeterministicCompactSummarizer();
    }
    return new ProviderSubagentSummarizer((context) => {
      if (context.kind !== "summarize") {
        return null;
      }
      return (
        this.dependencies.providerRouter?.selectProvider({
          kind: "summarize",
          taskId,
          sessionId
        }).provider ?? this.dependencies.provider
      );
    });
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

  private async invokeToolCall(
    state: ExecutionLoopState,
    task: TaskRecord,
    iteration: number,
    toolCall: ProviderToolCall
  ): Promise<{ outcome: ToolExecutionOutcome; toolCall: ProviderToolCall }> {
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
        taskMetadata: task.metadata,
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
        : `NOTE: duplicate tool call. You already invoked ${toolCall.toolName} with identical arguments at iteration ${priorCall.iteration} (call ${priorCall.toolCallId}). Do not call this tool again with the same arguments 鈥?synthesize from the prior result and answer the user.`;
    const finishedSummary =
      priorCall === null
        ? `${toolSummary} | ${structuredOutputSummary}`
        : `${toolSummary} | ${structuredOutputSummary} (duplicate of iter ${priorCall.iteration})`;
    const privacyLevel = toolDescriptor?.privacyLevel ?? "internal";

    if (toolDescriptor !== null) {
      if (toolDescriptor.capability !== "interaction.ask_user") {
        messages.push(
          duplicateNotice === null
            ? createToolFeedbackMessage(toolResultOutput, toolCall, privacyLevel)
            : createToolFeedbackMessageWithNotice(
                toolResultOutput,
                toolCall,
                privacyLevel,
                duplicateNotice
              )
        );
      }
      if (signature !== null && priorCall === null) {
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
    messages.push(
      duplicateNotice === null
        ? createToolFeedbackMessage(toolResultOutput, toolCall, privacyLevel)
        : createToolFeedbackMessageWithNotice(
            toolResultOutput,
            toolCall,
            privacyLevel,
            duplicateNotice
          )
    );
    if (signature !== null && priorCall === null) {
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

