import { randomUUID } from "node:crypto";

import { createManagedAbortController, throwIfAborted } from "./abort-controller.js";
import { AppError, toAppError } from "./app-error.js";
import { computeCostUsd } from "./budget/cost-calculator.js";
import {
  buildFilteredContextDebugFragments,
  ExecutionContextAssembler
} from "./context-assembler.js";
import {
  buildFinalSessionCompactInput,
  buildReviewerTracePayload,
  createToolFeedbackMessage,
  createToolFeedbackMessageWithNotice,
  DEDUPLICATABLE_CAPABILITIES,
  emitTaskEvent,
  estimateTokenCount,
  injectResumeContextMessages,
  normalizeProviderFailure,
  providerUsageToJson,
  historyHasSuccessfulWrite,
  readThreadResumeMemoryContext,
  readThreadResumeMessages,
  rebuildSignaturesFromMessages,
  rebuildTurnProviderMessages,
  sleepWithAbort,
  summarizeText,
  summarizeToolOutput,
  toConversationRole,
  toolCallSignature
} from "./kernel-support.js";
import { buildRepoMap } from "./repo-map.js";
import { tokenBudgetToJson } from "./serialization.js";
import type { ContextCompactor, ThreadSessionMemoryService } from "./context/index.js";
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
  TaskRecord,
  TaskRepository,
  ThreadCommitmentState,
  ThreadLineageRepository,
  ThreadRunRepository,
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
import type { ToolOrchestrator } from "../tools/index.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { BudgetService } from "./budget/budget-service.js";
import type { RuntimeOutputService } from "./runtime-output-service.js";

export interface ExecutionKernelDependencies {
  agentProfileRegistry: AgentProfileRegistry;
  compactPolicy: CompactTriggerPolicy;
  executionCheckpointRepository: ExecutionCheckpointRepository;
  getThreadCommitmentState?: (threadId: string) => ThreadCommitmentState | null;
  memoryPlane: MemoryPlane;
  recallPlanner: RecallPlanner;
  provider: Provider;
  runMetadataRepository: RunMetadataRepository;
  runtimeVersion: string;
  taskRepository: TaskRepository;
  threadRunRepository: ThreadRunRepository;
  threadLineageRepository: ThreadLineageRepository;
  contextCompactor: ContextCompactor;
  threadSessionMemoryService: ThreadSessionMemoryService;
  toolOrchestrator: ToolOrchestrator;
  traceService: TraceService;
  outputService: RuntimeOutputService;
  workflow: WorkflowRuntimeConfig;
  compact: RuntimeConfig["compact"];
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

const PROGRESS_GUARD_THRESHOLD = 3;
const POST_COMPLETION_VERIFICATION_READ_LIMIT = 1;

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
  criticalBudgetPressureEmitted: boolean;
  postCompletionVerificationReads: number;
  implementationReadOnlyGuardEmitted: boolean;
  implementationReadOnlyRounds: number;
  implementationWriteRequired: boolean;
  implementationWriteRequiredViolations: number;
  selectedSkillContext: ContextFragment[];
  silentToolTurns: number;
  noWriteFinalGuardEmitted: boolean;
  toolCallSignatures: Map<string, { iteration: number; toolCallId: string }>;
  turnFilteredFragments: ContextAssemblyDebugView["filteredOutFragments"];
  turnProviderMessages: ConversationMessage[];
  repoMapSummary?: string;
  task: TaskRecord;
  tokenBudget: TokenBudget;
  warningBudgetPressureEmitted: boolean;
  writeExpected: boolean;
  writeToolSucceeded: boolean;
}

export class ExecutionKernel {
  private readonly contextAssembler = new ExecutionContextAssembler();

  public constructor(private readonly dependencies: ExecutionKernelDependencies) {}

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
        threadId: input.task.threadId ?? null,
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
    let task = this.dependencies.taskRepository.create({
      agentProfileId: options.agentProfileId,
      cwd: options.cwd,
      input: options.taskInput,
      maxIterations: options.maxIterations,
      metadata: options.metadata ?? {},
      providerName: this.dependencies.provider.name,
      requesterUserId: options.userId,
      taskId,
      threadId: options.threadId ?? null,
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

    this.dependencies.runMetadataRepository.create({
      agentProfileId: options.agentProfileId,
      createdAt: new Date().toISOString(),
      metadata: options.metadata ?? {},
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
      const threadId = task.threadId ?? null;
      const initialToolExposure = this.dependencies.toolExposurePlanner
        ? await this.dependencies.toolExposurePlanner.plan({
            context: {
              agentProfileId: options.agentProfileId,
              cwd: options.cwd,
              iteration: 1,
              signal: managedAbortController.abortController.signal,
              taskId,
              userId: options.userId,
              workspaceRoot: this.dependencies.workspaceRoot
            },
            iteration: 1,
            taskId,
            threadId
          })
        : null;
      managedAbortController.touchActivity("tool_exposure_planned");
      const availableTools =
        initialToolExposure?.tools ?? this.dependencies.toolOrchestrator.listTools();
      const recallPlan = await this.planRecall({
        task,
        threadCommitmentState:
          threadId === null ? null : this.dependencies.getThreadCommitmentState?.(threadId) ?? null,
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
      const resumeContextMessages = readThreadResumeMessages(options.metadata);
      if (resumeContextMessages.length > 0) {
        injectResumeContextMessages(messages, resumeContextMessages);
      }
      const resumeMemoryContext = readThreadResumeMemoryContext(options.metadata);
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
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        managedAbortController,
        maxIterations: options.maxIterations,
        memoryContext: [...recallPlan.fragments, ...resumeMemoryContext],
        memoryRecall: null,
        messages,
        noWriteFinalGuardEmitted: false,
        ...(options.onAssistantTextDelta !== undefined
          ? { onAssistantTextDelta: options.onAssistantTextDelta }
          : {}),
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        ...(options.onTaskEvent !== undefined ? { onTaskEvent: options.onTaskEvent } : {}),
        pendingToolCalls: [],
        postCompletionVerificationReads: 0,
        implementationReadOnlyGuardEmitted: false,
        implementationReadOnlyRounds: 0,
        implementationWriteRequired: false,
        implementationWriteRequiredViolations: 0,
        ...(repoMap?.summary !== undefined ? { repoMapSummary: repoMap.summary } : {}),
        selectedSkillContext: recallPlan.fragments.filter((fragment) => fragment.scope === "skill_ref"),
        silentToolTurns: 0,
        task,
        toolCallSignatures: new Map(),
        turnFilteredFragments: [],
        turnProviderMessages: messages,
        tokenBudget: options.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeExpected: expectsFileModification(options.taskInput),
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

    const checkpoint = this.dependencies.executionCheckpointRepository.findByTaskId(taskId);
    if (checkpoint === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${taskId} has no execution checkpoint to resume.`
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
      const isDeduplicatable = (toolName: string): boolean => {
        const descriptor = this.dependencies.toolOrchestrator.describeTool(toolName);
        return descriptor !== null && DEDUPLICATABLE_CAPABILITIES.has(descriptor.capability);
      };
      const isWriteTool = (toolName: string): boolean => {
        const descriptor = this.dependencies.toolOrchestrator.describeTool(toolName);
        return descriptor?.capability === "filesystem.write" || toolName.includes("write");
      };
      const resumedWriteToolSucceeded = historyHasSuccessfulWrite(checkpoint.messages, isWriteTool);

      return await this.executeLoop({
        cwd: resumedTask.cwd,
        costWarnedToolNames: [],
        completionIntentSeenAt: null,
        criticalBudgetPressureEmitted: false,
        cumulativeToolCallCount: 0,
        managedAbortController,
        maxIterations: resumedTask.maxIterations,
        memoryContext: checkpoint.memoryContext,
        memoryRecall: null,
        messages: checkpoint.messages,
        noWriteFinalGuardEmitted: false,
        ...(options.onOutputEvent !== undefined ? { onOutputEvent: options.onOutputEvent } : {}),
        pendingToolCalls: checkpoint.pendingToolCalls,
        postCompletionVerificationReads: 0,
        implementationReadOnlyGuardEmitted: false,
        implementationReadOnlyRounds: 0,
        implementationWriteRequired: false,
        implementationWriteRequiredViolations: 0,
        selectedSkillContext: [],
        silentToolTurns: 0,
        task: resumedTask,
        toolCallSignatures: rebuildSignaturesFromMessages(checkpoint.messages, isDeduplicatable),
        turnFilteredFragments: [],
        turnProviderMessages: checkpoint.messages,
        tokenBudget: resumedTask.tokenBudget,
        warningBudgetPressureEmitted: false,
        writeExpected: expectsFileModification(resumedTask.input),
        writeToolSucceeded: resumedWriteToolSucceeded
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

    this.dependencies.executionCheckpointRepository.delete(taskId);
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

    this.dependencies.executionCheckpointRepository.delete(taskId);
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
      this.maybeInjectIterationBudgetPressure(state, iteration);
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
              userId: task.requesterUserId,
              workspaceRoot: this.dependencies.workspaceRoot
            },
            iteration,
            taskId: task.taskId,
            threadId: task.threadId ?? null
          });
          availableTools = exposure.tools;
          state.costWarnedToolNames = exposure.decisions
            .filter((decision) => decision.costWarning === true)
            .map((decision) => decision.toolName);
          state.managedAbortController.touchActivity("tool_exposure_planned");
        } else {
          availableTools = baseAvailableTools;
        }
        availableTools = this.applyRuntimeToolGate(state, availableTools, iteration);
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
            threadId: task.threadId ?? null,
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
        const noWriteFinalDecision =
          providerResponse.kind === "final"
            ? this.evaluateNoWriteFinal(state)
            : "accept";
        const deferNoWriteFinal = noWriteFinalDecision === "defer";
        const rejectNoWriteFinal = noWriteFinalDecision === "fail";
        const assistantDisplay =
          providerResponse.kind === "final" && !deferNoWriteFinal && !rejectNoWriteFinal
            ? "final"
            : "intermediate";
        const transcriptVisibility =
          providerResponse.kind === "tool_calls" || deferNoWriteFinal || rejectNoWriteFinal
            ? "hidden"
            : "visible";

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

        const visibleReasoningText = providerResponse.message.trim();
        if (providerResponse.kind === "tool_calls" && visibleReasoningText.length === 0) {
          state.silentToolTurns += 1;
        } else {
          state.silentToolTurns = 0;
        }
        if (
          providerResponse.kind === "tool_calls" &&
          state.silentToolTurns >= PROGRESS_GUARD_THRESHOLD
        ) {
          messages.push({
            content:
              `progress guard: you have made ${state.silentToolTurns} consecutive tool-call rounds at iterations ${iteration - state.silentToolTurns + 1}-${iteration} without writing any visible reasoning text. Stop calling tools and answer the user's request based on what you already know. If the original question was conceptual or general-knowledge, answer directly without further tool use.`,
            metadata: {
              privacyLevel: "internal",
              retentionKind: "session",
              sourceType: "system_prompt"
            },
            role: "system"
          });
          state.silentToolTurns = 0;
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
        const pricing = this.dependencies.budgetPricing?.[resolvedProviderName];
        const costUsd = computeCostUsd(providerResponse.usage, pricing);
        state.tokenBudget = {
          ...state.tokenBudget,
          usedCostUsd: (state.tokenBudget.usedCostUsd ?? 0) + (costUsd ?? 0),
          usedInput: (state.tokenBudget.usedInput ?? 0) + providerResponse.usage.inputTokens,
          usedOutput: (state.tokenBudget.usedOutput ?? 0) + providerResponse.usage.outputTokens
        };
        task = this.dependencies.taskRepository.update(task.taskId, {
          tokenBudget: state.tokenBudget
        });
        this.dependencies.traceService.record({
          actor: "runtime.budget",
          eventType: "cost_report",
          payload: {
            cachedInputTokens: providerResponse.usage.cachedInputTokens ?? 0,
            costUsd,
            inputTokens: providerResponse.usage.inputTokens,
            mode: this.dependencies.routingMode ?? "balanced",
            outputTokens: providerResponse.usage.outputTokens,
            providerName: resolvedProviderName,
            taskId: task.taskId,
            threadId: task.threadId ?? null
          },
          stage: "control",
          summary: "Cost usage recorded",
          taskId: task.taskId
        });
        const budgetDecision = this.dependencies.budgetService?.recordUsage({
          costUsd,
          mode: this.dependencies.routingMode ?? "balanced",
          taskId: task.taskId,
          threadId: task.threadId ?? null,
          usage: providerResponse.usage
        });
        if (budgetDecision?.action === "hard_abort") {
          throw new AppError({
            code: "budget_exceeded",
            message: budgetDecision.reasons.join("; ") || "Budget hard limit exceeded."
          });
        }

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

        if (deferNoWriteFinal) {
          this.injectNoWriteFinalGuard(state, messages);
          state.turnProviderMessages = rebuildTurnProviderMessages(messages, state.turnProviderMessages);
          continue;
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
          if (noWriteFinalDecision === "fail") {
            throw new AppError({
              code: "task_incomplete",
              details: {
                reason: "implementation_final_without_file_changes"
              },
              message:
                "Implementation task ended without any successful filesystem write. The model tried to finish after inspection only."
            });
          }
          return this.completeTaskSuccess(
            state,
            messages,
            availableTools,
            task,
            providerResponse.message
          );
        }

        const postCompletionDecision = this.evaluatePostCompletionToolCalls(
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
      const executingToolCalls = pendingToolCalls;
      for (const [toolIndex, toolCall] of pendingToolCalls.entries()) {
        throwIfAborted(
          state.managedAbortController.abortController.signal,
          state.managedAbortController.getReason()
        );
        emitTaskEvent(state.onTaskEvent, {
          iteration,
          kind: "tool",
          status: "started",
          taskId: task.taskId,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName
        });
        state.managedAbortController.touchActivity("tool_call_started");

        const blockedToolResult = this.buildUnavailableToolResult(
          state,
          availableTools,
          toolCall,
          iteration
        );
        const outcome =
          blockedToolResult === null
            ? await this.dependencies.toolOrchestrator.execute(
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
              )
            : {
                kind: "completed" as const,
                result: blockedToolResult
              };
        state.managedAbortController.touchActivity(`tool_call_${outcome.kind}`);

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
          this.dependencies.executionCheckpointRepository.save({
            iteration,
            memoryContext: state.memoryContext,
            messages,
            pendingToolCalls: pendingToolCalls.slice(toolIndex),
            pendingClarifyPromptId: null,
            taskId: task.taskId,
            updatedAt: new Date().toISOString()
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
          this.dependencies.executionCheckpointRepository.save({
            iteration,
            memoryContext: state.memoryContext,
            messages,
            pendingClarifyPromptId: outcome.prompt.promptId,
            pendingToolCalls: pendingToolCalls.slice(toolIndex),
            taskId: task.taskId,
            updatedAt: new Date().toISOString()
          });

          return {
            output: null,
            task
          };
        }

        toolCallCount += 1;
        state.cumulativeToolCallCount += 1;
        const toolDescriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
        if (
          outcome.result.success &&
          (toolDescriptor?.capability === "filesystem.write" ||
            toolCall.toolName.includes("write"))
        ) {
          state.writeToolSucceeded = true;
        }
        const toolResultOutput = toolResultOutputForModel(outcome.result);
        const toolSummary = toolResultSummary(outcome.result, toolCall.toolName);
        const structuredOutputSummary = summarizeToolOutput(toolResultOutput);
        const isDeduplicatable =
          toolDescriptor !== null && DEDUPLICATABLE_CAPABILITIES.has(toolDescriptor.capability);
        const signature = isDeduplicatable
          ? toolCallSignature(toolCall.toolName, toolCall.input)
          : null;
        const priorCall =
          signature === null ? null : state.toolCallSignatures.get(signature) ?? null;
        const duplicateNotice =
          priorCall === null
            ? null
            : `NOTE: duplicate tool call. You already invoked ${toolCall.toolName} with identical arguments at iteration ${priorCall.iteration} (call ${priorCall.toolCallId}). Do not call this tool again with the same arguments — synthesize from the prior result and answer the user.`;
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
          if (
            state.implementationWriteRequired &&
            state.implementationWriteRequiredViolations >= 2
          ) {
            throw new AppError({
              code: "task_incomplete",
              details: {
                iteration,
                reason: "implementation_write_required_tool_gate_ignored",
                toolName: toolCall.toolName
              },
              message:
                "Implementation task ignored the write-required tool gate and kept requesting read-only tools instead of writing files."
            });
          }
          continue;
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
        if (
          state.implementationWriteRequired &&
          state.implementationWriteRequiredViolations >= 2
        ) {
          throw new AppError({
            code: "task_incomplete",
            details: {
              iteration,
              reason: "implementation_write_required_tool_gate_ignored",
              toolName: toolCall.toolName
            },
            message:
              "Implementation task ignored the write-required tool gate and kept requesting read-only tools instead of writing files."
          });
        }
      }

      pendingToolCalls = [];
      this.updateImplementationReadLoopGuard(state, messages, iteration, executingToolCalls);
      this.dependencies.executionCheckpointRepository.delete(task.taskId);
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
        sessionScopeKey: task.threadId ?? task.taskId,
        taskId: task.taskId,
        tokenEstimate: estimateTokenCount(messages),
        tokenThreshold: this.dependencies.compact.tokenThreshold,
        toolCallCount: state.cumulativeToolCallCount,
        toolCallThreshold: this.dependencies.compact.toolCallThreshold
      });
      if (compacted.triggered) {
        const compactReason = compacted.reason ?? "message_count";
        const preCompactMessages = [...messages];
        if (task.threadId !== null && task.threadId !== undefined) {
          const latestRun = this.dependencies.threadRunRepository.findLatestByThreadId(task.threadId);
          this.dependencies.threadLineageRepository.append({
            eventType: "compress",
            lineageId: randomUUID(),
            payload: {
              messageCount: messages.length,
              reason: compactReason
            },
            sourceRunId: latestRun?.runId ?? null,
            targetRunId: latestRun?.runId ?? null,
            threadId: task.threadId
          });
          const compactInput = {
            iteration,
            iterationThreshold: this.dependencies.compact.iterationThreshold,
            maxMessagesBeforeCompact: this.dependencies.compact.messageThreshold,
            messages: preCompactMessages,
            originalGoal: task.input,
            pendingToolCalls,
            reason: compactReason,
            sessionScopeKey: task.threadId,
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
                threadId: task.threadId,
                timeoutMs: 5_000,
                workerId: randomUUID(),
                workerKind: "summarizer"
              },
              (input) => summarizerWorker.execute(input)
            );
          } else {
            const sessionMemoryDraft = this.dependencies.contextCompactor.buildSessionMemory({
              availableTools,
              compact: compactInput,
              task
            });
            this.dependencies.threadSessionMemoryService.create({
              ...sessionMemoryDraft,
              runId: latestRun?.runId ?? null,
              threadId: task.threadId,
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
        const refreshThreadId = task.threadId ?? null;
        const refreshedContext = await this.planRecall({
          task,
          threadCommitmentState:
            refreshThreadId === null
              ? null
              : this.dependencies.getThreadCommitmentState?.(refreshThreadId) ?? null,
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

  private maybeInjectIterationBudgetPressure(state: ExecutionLoopState, iteration: number): void {
    const ratio = iteration / Math.max(1, state.maxIterations);
    const tier = ratio >= 0.9 ? "critical" : ratio >= 0.7 ? "warning" : null;
    if (tier === null) {
      return;
    }
    if (tier === "warning" && state.warningBudgetPressureEmitted) {
      return;
    }
    if (tier === "critical" && state.criticalBudgetPressureEmitted) {
      return;
    }
    if (tier === "warning") {
      state.warningBudgetPressureEmitted = true;
    } else {
      state.criticalBudgetPressureEmitted = true;
    }
    const remainingIterations = Math.max(0, state.maxIterations - iteration + 1);
    const pressureMessage: ConversationMessage = {
      content:
        tier === "critical"
          ? `Iteration budget critical: ${remainingIterations}/${state.maxIterations} loop iterations remain. Stop nonessential tool calls now and provide the final answer as soon as possible.`
          : `Iteration budget warning: ${remainingIterations}/${state.maxIterations} loop iterations remain. Begin converging; use tools only if they are required to finish the user's request.`,
      metadata: {
        privacyLevel: "internal",
        retentionKind: "session",
        sourceType: "system_prompt"
      },
      role: "system"
    };
    state.messages.push(pressureMessage);
    if (state.turnProviderMessages !== state.messages) {
      state.turnProviderMessages.push(pressureMessage);
    }
    this.dependencies.traceService.record({
      actor: "runtime.loop",
      eventType: "iteration_budget_pressure",
      payload: {
        iteration,
        maxIterations: state.maxIterations,
        remainingIterations,
        tier
      },
      stage: "control",
      summary: `Iteration budget pressure: ${tier}`,
      taskId: state.task.taskId
    });
  }

  private evaluateNoWriteFinal(state: ExecutionLoopState): "accept" | "defer" | "fail" {
    if (!state.writeExpected || state.writeToolSucceeded) {
      return "accept";
    }
    return state.noWriteFinalGuardEmitted ? "fail" : "defer";
  }

  private injectNoWriteFinalGuard(
    state: ExecutionLoopState,
    messages: ConversationMessage[]
  ): void {
    state.noWriteFinalGuardEmitted = true;
    messages.push({
      content:
        "Stop verifier: the user asked for an implementation or code-change task, but this run has not completed any successful filesystem write. Do not final-answer yet. If changes are required, call file_write now. If you are blocked from changing files, final-answer with the blocker. Do not claim the work is complete based only on reads.",
      metadata: {
        privacyLevel: "internal",
        retentionKind: "session",
        sourceType: "system_prompt"
      },
      role: "system"
    });
  }

  private updateImplementationReadLoopGuard(
    state: ExecutionLoopState,
    messages: ConversationMessage[],
    iteration: number,
    toolCalls: ProviderToolCall[]
  ): void {
    if (!state.writeExpected || state.writeToolSucceeded) {
      state.implementationReadOnlyRounds = 0;
      state.implementationReadOnlyGuardEmitted = false;
      state.implementationWriteRequired = false;
      state.implementationWriteRequiredViolations = 0;
      return;
    }
    if (!allToolCallsAreReads(toolCalls)) {
      state.implementationReadOnlyRounds = 0;
      state.implementationReadOnlyGuardEmitted = false;
      return;
    }

    state.implementationReadOnlyRounds += 1;
    if (
      state.implementationReadOnlyRounds >= 6 &&
      !state.implementationReadOnlyGuardEmitted
    ) {
      state.implementationReadOnlyGuardEmitted = true;
      state.implementationWriteRequired = true;
      state.implementationWriteRequiredViolations = 0;
      messages.push({
        content:
          "Read-loop guard: this is an implementation task and the run has spent several consecutive turns only reading files without any successful filesystem write. The runtime is now entering write-required mode and will temporarily withhold read-only tools. Use the existing tool results to call file_write now, or final-answer with a blocker if you cannot make the change. Do not request more read tools until a successful write happens.",
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      });
    }

    if (state.implementationReadOnlyRounds >= 12) {
      throw new AppError({
        code: "task_incomplete",
        details: {
          iteration,
          readOnlyRounds: state.implementationReadOnlyRounds,
          reason: "implementation_read_loop_without_file_changes"
        },
        message:
          "Implementation task made too many consecutive read-only turns without any successful filesystem write."
      });
    }
  }

  private applyRuntimeToolGate(
    state: ExecutionLoopState,
    availableTools: ProviderToolDescriptor[],
    iteration: number
  ): ProviderToolDescriptor[] {
    if (!state.implementationWriteRequired || !state.writeExpected || state.writeToolSucceeded) {
      return availableTools;
    }

    const gatedTools = availableTools.filter((tool) => isAllowedInWriteRequiredMode(tool));
    if (gatedTools.length === availableTools.length) {
      return availableTools;
    }

    this.dependencies.traceService.record({
      actor: "runtime.tool_gate",
      eventType: "runtime_tool_gate_applied",
      payload: {
        hiddenTools: availableTools
          .filter((tool) => !gatedTools.includes(tool))
          .map((tool) => tool.name),
        iteration,
        mode: "write_required",
        visibleTools: gatedTools.map((tool) => tool.name)
      },
      stage: "control",
      summary: "Write-required runtime tool gate applied",
      taskId: state.task.taskId
    });

    return gatedTools;
  }

  private buildUnavailableToolResult(
    state: ExecutionLoopState,
    availableTools: ProviderToolDescriptor[],
    toolCall: ProviderToolCall,
    iteration: number
  ): ToolExecutionResult | null {
    const availableToolNames = new Set(availableTools.map((tool) => tool.name));
    if (availableToolNames.has(toolCall.toolName)) {
      return null;
    }
    if (!state.implementationWriteRequired) {
      return null;
    }

    const descriptor = this.dependencies.toolOrchestrator.describeTool(toolCall.toolName);
    const readOnlyTool = isReadOnlyToolDescriptor(descriptor, toolCall.toolName);
    const availableToolList = [...availableToolNames].join(", ");
    const reason = readOnlyTool
      ? `Tool ${toolCall.toolName} is temporarily unavailable because this implementation task entered write-required mode after repeated read-only turns. Use file_write now, or final-answer with a concrete blocker. Do not call additional read-only tools until a successful write happens.`
      : `Tool ${toolCall.toolName} is temporarily unavailable because this implementation task entered write-required mode without a successful file write. Use file_write now, or final-answer with a concrete blocker. Available tools: ${
          availableToolList.length > 0 ? availableToolList : "none"
        }.`;

    state.implementationWriteRequiredViolations += 1;

    this.dependencies.traceService.record({
      actor: "runtime.tool_gate",
      eventType: "tool_call_blocked",
      payload: {
        availableTools: [...availableToolNames],
        iteration,
        mode: state.implementationWriteRequired ? "write_required" : "normal",
        reason,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        violationCount: state.implementationWriteRequiredViolations
      },
      stage: "control",
      summary: `Blocked unavailable tool call ${toolCall.toolName}`,
      taskId: state.task.taskId
    });

    return {
      details: {
        availableTools: [...availableToolNames],
        mode: state.implementationWriteRequired ? "write_required" : "normal",
        requestedTool: toolCall.toolName
      },
      errorCode: "tool_unavailable",
      errorMessage: reason,
      success: false
    };
  }

  private evaluatePostCompletionToolCalls(
    state: ExecutionLoopState,
    iteration: number,
    providerResponse: Extract<ProviderResponse, { kind: "tool_calls" }>
  ): "continue" | "summarize" {
    if (!state.writeToolSucceeded || !allToolCallsAreReads(providerResponse.toolCalls)) {
      return "continue";
    }

    if (state.completionIntentSeenAt === null && hasCompletionIntent(providerResponse.message)) {
      state.completionIntentSeenAt = iteration;
    }
    if (state.completionIntentSeenAt === null) {
      return "continue";
    }

    if (state.postCompletionVerificationReads >= POST_COMPLETION_VERIFICATION_READ_LIMIT) {
      return "summarize";
    }
    state.postCompletionVerificationReads += 1;
    return "continue";
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
        threadId: task.threadId ?? null,
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
    this.dependencies.executionCheckpointRepository.delete(task.taskId);
    const completedTask = this.dependencies.taskRepository.update(task.taskId, {
      finalOutput,
      finishedAt: new Date().toISOString(),
      status: "succeeded"
    });
    this.dependencies.memoryPlane.recordFinalOutcome(completedTask, finalOutput);

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

    this.persistThreadRun(completedTask, completedTask.input, {
      finalOutput,
      status: completedTask.status
    });
    if (completedTask.threadId !== null && completedTask.threadId !== undefined) {
      const latestRun =
        this.dependencies.threadRunRepository.findByTaskId(completedTask.taskId) ??
        this.dependencies.threadRunRepository.findLatestByThreadId(completedTask.threadId);
      const finalSessionMemoryDraft = this.dependencies.contextCompactor.buildSessionMemory({
        availableTools,
        compact: buildFinalSessionCompactInput(messages, completedTask),
        task: completedTask,
        trigger: "final"
      });
      this.dependencies.threadSessionMemoryService.create({
        ...finalSessionMemoryDraft,
        runId: latestRun?.runId ?? null,
        threadId: completedTask.threadId,
        trigger: "final"
      });
    }

    return {
      output: finalOutput,
      task: completedTask
    };
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

    const summarizer = this.selectCompactSummarizer(input.taskId, input.sessionScopeKey);
    const summarized = await summarizer.summarize({
      maxMessagesBeforeCompact: input.maxMessagesBeforeCompact,
      messages: input.messages,
      ...(input.originalGoal !== undefined ? { originalGoal: input.originalGoal } : {}),
      sessionScopeKey: input.sessionScopeKey,
      taskId: input.taskId
    });
    const preserved = input.messages.slice(-3).map((message) => ({
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

  private selectCompactSummarizer(taskId: string, threadId: string | null): CompactSummarizer {
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
          threadId
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

    this.dependencies.executionCheckpointRepository.delete(task.taskId);
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

    this.persistThreadRun(task, task.input, {
      errorCode: error.code,
      errorMessage: error.message,
      status: isCancelled ? "cancelled" : "failed"
    });

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

  private persistThreadRun(
    task: TaskRecord,
    input: string,
    summary: {
      status: TaskRecord["status"];
      finalOutput?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    }
  ): void {
    if (task.threadId === null || task.threadId === undefined) {
      return;
    }
    if (this.dependencies.threadRunRepository.findByTaskId(task.taskId) !== null) {
      return;
    }
    this.dependencies.threadRunRepository.create({
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
      threadId: task.threadId
    });
  }

  private emitOutput(draft: Parameters<RuntimeOutputService["record"]>[0]): RuntimeOutputEvent {
    return this.dependencies.outputService.record(draft);
  }
}

function allToolCallsAreReads(toolCalls: ProviderToolCall[]): boolean {
  return toolCalls.length > 0 && toolCalls.every((call) => isReadOnlyToolName(call.toolName));
}

function isAllowedInWriteRequiredMode(tool: ProviderToolDescriptor): boolean {
  return tool.capability === "filesystem.write";
}

function isReadOnlyToolDescriptor(
  descriptor: ProviderToolDescriptor | null,
  toolName: string
): boolean {
  if (descriptor !== null) {
    return (
      descriptor.capability === "filesystem.read" ||
      descriptor.capability === "network.fetch_public_readonly"
    );
  }
  return isReadOnlyToolName(toolName);
}

function isReadOnlyToolName(toolName: string): boolean {
  return (
    toolName.includes("read") ||
    toolName.includes("search") ||
    toolName.includes("fetch") ||
    toolName.includes("view")
  );
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

function hasCompletionIntent(message: string): boolean {
  const compact = message.replace(/\s+/gu, " ").trim().toLowerCase();
  if (compact.length === 0) {
    return false;
  }
  const planningSignals = [
    "让我",
    "我需要",
    "需要我继续",
    "let me",
    "need to",
    "what's missing",
    "this tool call"
  ];
  if (planningSignals.some((signal) => compact.includes(signal))) {
    return false;
  }
  const completionSignals = [
    /已完成/u,
    /第一阶段[^。.!?]{0,30}完成/u,
    /基础框架搭建[^。.!?]{0,30}完成/u,
    /完成情况/u,
    /all files are complete/u,
    /complete and functional/u,
    /completed the .*task/u,
    /implementation is complete/u
  ];
  return completionSignals.some((pattern) => pattern.test(compact));
}

function expectsFileModification(input: string): boolean {
  const compact = input.replace(/\s+/gu, " ").trim().toLowerCase();
  if (compact.length === 0) {
    return false;
  }
  const strongWriteIntent =
    /\b(implement|fix|modify|update|add|create|build|write|develop|repair|refactor|change)\b/u.test(
      compact
    ) ||
    /(?:\u5b9e\u73b0|\u4fee\u590d|\u4fee\u6539|\u6539\u9020|\u65b0\u589e|\u6dfb\u52a0|\u7f16\u5199|\u5199\u4ee3\u7801|\u91cd\u6784|\u4f18\u5316|\u5b8c\u6210.*(?:\u5f00\u53d1|\u4efb\u52a1|\u9636\u6bb5|\u529f\u80fd))/u.test(
      compact
    );
  if (strongWriteIntent) {
    return true;
  }
  const readOnlyIntent =
    /\b(inspect|summarize|explain|analyze|review|look|list|read|show)\b/u.test(compact) ||
    /(?:\u67e5\u770b|\u603b\u7ed3|\u5206\u6790|\u89e3\u91ca|\u5217\u51fa|\u8bfb\u53d6)/u.test(
      compact
    );
  const weakCodeIntent = /\b(code|development)\b/u.test(compact) || /\u5f00\u53d1|\u4ee3\u7801/u.test(compact);
  return weakCodeIntent && !readOnlyIntent;
}
