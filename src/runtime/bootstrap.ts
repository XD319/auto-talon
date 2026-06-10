import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DiffDisplayMode } from "../presentation/diff-display.js";
import { ApprovalService } from "../approvals/approval-service.js";
import { ApprovalRuleStore } from "../approvals/approval-rule-store.js";
import { ClarifyService } from "../approvals/clarify-service.js";
import { AuditService } from "../audit/audit-service.js";
import { ExperienceCollector } from "../experience/experience-collector.js";
import { ExperiencePlane } from "../experience/experience-plane.js";
import { PromotionAdvisor } from "../experience/promotion/promotion-advisor.js";
import { MemoryPlane } from "../memory/memory-plane.js";
import { CompactTriggerPolicy } from "../memory/compact-policy.js";
import { McpClientManager } from "../mcp/index.js";
import { ContextPolicy } from "../policy/context-policy.js";
import { DEFAULT_LOCAL_POLICY_CONFIG } from "../policy/default-policy-config.js";
import { PolicyEngine } from "../policy/policy-engine.js";
import { AgentProfileRegistry } from "../profiles/agent-profile-registry.js";
import {
  createProvider,
  ManagedProvider,
  ProviderRouter,
  resolveProviderCatalog,
  resolveProviderConfig,
  resolveProviderConfigForProvider,
  type ProviderCatalogEntry,
  type ResolvedProviderConfig
} from "../providers/index.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { SkillContextService, SkillDraftManager, SkillRegistry } from "../skills/index.js";
import { SkillVersionRegistry } from "../skills/versioning/index.js";
import { StorageManager } from "../storage/database.js";
import { migrateConfigFiles, validateConfigVersions } from "../storage/config-migration.js";
import { RUNTIME_SCHEMA_VERSION } from "../storage/migrations.js";
import { TraceService } from "../tracing/trace-service.js";
import type {
  BudgetLimits,
  LocalPolicyConfig,
  Provider,
  RuntimeRunOptions,
  SandboxMode,
  SandboxProfile,
  TokenBudget
} from "../types/index.js";
import {
  AskUserTool,
  CodeSearchTool,
  DelegateTaskTool,
  GlobTool,
  PatchTool,
  ProcessTool,
  ReadFileTool,
  WriteFileTool,
  ShellTool,
  SkillsListTool,
  SkillViewTool,
  TerminalSessionManager,
  ToolOrchestrator,
  ToolRegistry,
  WebFetchTool,
  WebSearchTool,
  SessionSearchTool,
  TodoTool
} from "../tools/index.js";
import { TodoSessionStore } from "../tools/todo-session-store.js";
import { DockerShellExecutor } from "../tools/shell/docker-shell-executor.js";
import { ShellExecutor } from "../tools/shell/shell-executor.js";

import { AgentApplicationService } from "./application-service.js";
import { ContextCompactor, SessionSearchService, SessionSummaryService } from "./context/index.js";
import { BudgetService } from "./budget/index.js";
import { ExecutionKernel } from "./execution-kernel.js";
import { RuntimeOutputService } from "./runtime-output-service.js";
import { RecallBudgetPolicy, RecallPlanner } from "./retrieval/index.js";
import { DeliveryService } from "./delivery/index.js";
import { InboxCollector, InboxService } from "./inbox/index.js";
import {
  AssistantSessionProjectionService,
  CommitmentCollector,
  CommitmentService,
  NextActionService,
  SessionCommitmentProjector
} from "./commitments/index.js";
import { JobRunner } from "./jobs/index.js";
import { SchedulerService } from "./scheduler/index.js";
import { ResumePacketBuilder, SessionService, SessionStateProjector } from "./sessions/index.js";
import {
  SessionBranchService,
  SessionHandoffService,
  SessionIndexService,
  SessionMessageProjector,
  SessionMessageSearchService,
  SessionUiStateService
} from "./sessions/index.js";
import { RetrievalWorker, SummarizerWorker, WorkerDispatcher } from "./workers/index.js";
import type { ContextRetentionConfig } from "./context/recent-file-reads.js";
import {
  resolveRuntimeConfig,
  type WebSearchRuntimeConfig,
  type WorkflowCustomShell,
  type WorkflowRuntimeConfig
} from "./runtime-config.js";
import { ToolOverrideStore } from "../tools/tool-overrides.js";
import { ToolExposurePlanner } from "./tool-exposure-planner.js";
import { initializeWorkspaceFiles } from "./workspace-setup.js";

export const RUNTIME_VERSION = "0.1.0";

function createCustomShellExecutor(customShell: WorkflowCustomShell | null): ShellExecutor {
  if (customShell === null) {
    throw new Error("workflow.customShell.executable is required when workflow.shellBackend is custom.");
  }
  return new ShellExecutor({
    shellArgs: customShell.args,
    shellExecutable: customShell.executable
  });
}

export interface AppConfig {
  approvalTtlMs: number;
  allowedFetchHosts: string[];
  databasePath: string;
  defaultMaxIterations: number;
  defaultProfileId: "executor" | "planner" | "reviewer";
  defaultTimeoutMs: number;
  compact: {
    bufferTokens: number;
    iterationThreshold: number;
    messageThreshold: number;
    summarizer: "deterministic" | "provider_subagent";
    tailMinMessages: number;
    tailTokenBudget: number;
    thresholdRatio: number;
    tokenThreshold: number | null;
    toolCallThreshold: number;
  };
  contextRetention: ContextRetentionConfig;
  recall: {
    enabled: boolean;
    budgetRatio: number;
    maxCandidatesPerScope: number;
  };
  promotion: {
    enabled: boolean;
    minSuccessCount: number;
    minSuccessRate: number;
    minStability: number;
    maxHumanJudgmentWeight: number;
    riskDenyKeywords: string[];
  };
  routing: {
    mode: "cheap_first" | "balanced" | "quality_first";
    providers: {
      cheap?: string;
      balanced?: string;
      quality?: string;
    };
    helpers: {
      summarize: "cheap" | "balanced" | "quality" | null;
      classify: "cheap" | "balanced" | "quality" | null;
      recallRank: "cheap" | "balanced" | "quality" | null;
    };
  };
  budget: {
    task: BudgetLimits;
    session: BudgetLimits;
    pricing: Record<
      string,
      { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number | undefined }
    >;
  };
  provider: ResolvedProviderConfig;
  runtimeVersion: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  sandbox: SandboxProfile;
  tokenBudget: TokenBudget;
  tui: {
    diffDisplay: DiffDisplayMode;
  };
  webSearch: WebSearchRuntimeConfig;
  workflow: WorkflowRuntimeConfig;
  workspaceRoot: string;
}

export interface ResolveAppConfigOptions {
  sandboxMode?: SandboxMode;
  sandboxProfile?: string;
  writeRoots?: string[];
}

export function resolveAppConfig(cwd = process.cwd(), options: ResolveAppConfigOptions = {}): AppConfig {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  initializeWorkspaceFiles(workspaceRoot);
  migrateConfigFiles(workspaceRoot);
  validateConfigVersions(workspaceRoot);
  const provider = resolveProviderConfig(workspaceRoot);
  const sandbox = resolveSandboxProfile(workspaceRoot, options);
  const runtimeConfig = resolveRuntimeConfig(workspaceRoot);

  return {
    approvalTtlMs: 5 * 60_000,
    allowedFetchHosts: runtimeConfig.allowedFetchHosts,
    databasePath:
      process.env.AGENT_RUNTIME_DB_PATH ??
      join(workspaceRoot, ".auto-talon", "agent-runtime.db"),
    defaultMaxIterations: runtimeConfig.defaultMaxIterations,
    defaultProfileId: "executor",
    defaultTimeoutMs: runtimeConfig.defaultTimeoutMs,
    compact: runtimeConfig.compact,
    contextRetention: runtimeConfig.contextRetention,
    recall: runtimeConfig.recall,
    promotion: runtimeConfig.promotion,
    routing: runtimeConfig.routing,
    budget: runtimeConfig.budget,
    provider,
    runtimeVersion: RUNTIME_VERSION,
    runtimeConfigPath: runtimeConfig.configPath,
    runtimeConfigSource: runtimeConfig.configSource,
    sandbox,
    tokenBudget: runtimeConfig.tokenBudget,
    tui: runtimeConfig.tui,
    webSearch: runtimeConfig.webSearch,
    workflow: runtimeConfig.workflow,
    workspaceRoot
  };
}

function resolveWorkspaceRoot(cwd: string): string {
  const envWorkspaceRoot = process.env.AGENT_WORKSPACE_ROOT?.trim();
  if (envWorkspaceRoot !== undefined && envWorkspaceRoot.length > 0) {
    return resolve(envWorkspaceRoot);
  }

  const requestedRoot = resolve(cwd);
  return findWorkspaceRoot(requestedRoot) ?? requestedRoot;
}

function findWorkspaceRoot(startPath: string): string | null {
  let candidate = startPath;

  while (true) {
    if (existsSync(join(candidate, ".auto-talon", "runtime.config.json"))) {
      return candidate;
    }

    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
}

export interface AppRuntimeHandle {
  close: () => void;
  config: AppConfig;
  infrastructure: {
    mcpClientManager: McpClientManager;
    approvalService: ApprovalService;
    auditService: AuditService;
    createRunOptions: (taskInput: string, cwd: string) => RuntimeRunOptions;
    skillRegistry: SkillRegistry;
    sessionService: SessionService;
    toolOrchestrator: ToolOrchestrator;
    traceService: TraceService;
    storage: StorageManager;
  };
  service: AgentApplicationService;
}

export interface CreateApplicationOptions {
  config?: Partial<AppConfig>;
  policyConfig?: LocalPolicyConfig;
  provider?: Provider;
  providerCatalog?: ProviderCatalogEntry[];
  scheduler?: {
    autoStart?: boolean;
  };
  sandbox?: ResolveAppConfigOptions;
}

export function createApplication(
  cwd = process.cwd(),
  options: CreateApplicationOptions = {}
): AppRuntimeHandle {
  const resolvedConfig = resolveAppConfig(cwd, options.sandbox);
  backupDatabaseIfMigrationNeeded(resolvedConfig.workspaceRoot, resolvedConfig.databasePath);
  const configuredWorkspaceRoot = options.config?.workspaceRoot ?? resolvedConfig.workspaceRoot;
  const resolvedSandbox =
    configuredWorkspaceRoot === resolvedConfig.workspaceRoot
      ? resolvedConfig.sandbox
      : resolveSandboxProfile(configuredWorkspaceRoot, options.sandbox ?? {});
  const config = {
    ...resolvedConfig,
    ...options.config,
    budget: {
      ...resolvedConfig.budget,
      ...options.config?.budget,
      pricing: {
        ...resolvedConfig.budget.pricing,
        ...options.config?.budget?.pricing
      },
      session: {
        ...resolvedConfig.budget.session,
        ...options.config?.budget?.session
      },
      task: {
        ...resolvedConfig.budget.task,
        ...options.config?.budget?.task
      }
    },
    compact: {
      ...resolvedConfig.compact,
      ...options.config?.compact
    },
    contextRetention: {
      ...resolvedConfig.contextRetention,
      ...options.config?.contextRetention
    },
    recall: {
      ...resolvedConfig.recall,
      ...options.config?.recall
    },
    routing: {
      ...resolvedConfig.routing,
      ...options.config?.routing,
      helpers: {
        ...resolvedConfig.routing.helpers,
        ...options.config?.routing?.helpers
      },
      providers: {
        ...resolvedConfig.routing.providers,
        ...options.config?.routing?.providers
      }
    },
    sandbox: {
      ...resolvedSandbox,
      ...options.config?.sandbox
    },
    tokenBudget: {
      ...resolvedConfig.tokenBudget,
      ...options.config?.tokenBudget
    },
    webSearch: {
      ...resolvedConfig.webSearch,
      ...options.config?.webSearch
    },
    workflow: {
      ...resolvedConfig.workflow,
      ...options.config?.workflow,
      failureGuidedRetry: {
        ...resolvedConfig.workflow.failureGuidedRetry,
        ...options.config?.workflow?.failureGuidedRetry
      },
      repoMap: {
        ...resolvedConfig.workflow.repoMap,
        ...options.config?.workflow?.repoMap
      }
    }
  };
  const provider =
    options.provider === undefined
      ? createProvider(config.provider)
      : new ManagedProvider(options.provider, config.provider);

  const storage = new StorageManager({
    databasePath: config.databasePath
  });
  const traceService = new TraceService(storage.traces);
  const outputService = new RuntimeOutputService(storage.outputs, (taskId) => storage.tasks.findById(taskId));
  const stopOutputTraceProjection = traceService.subscribe((event) => outputService.projectTrace(event));
  const auditService = new AuditService(storage.auditLogs);
  const budgetService = new BudgetService(config.budget, traceService, auditService);
  budgetService.start();
  const routedProviders = new Map<string, Provider>();
  const providerRouter = new ProviderRouter(
    config.routing,
    (providerName) => {
      if (providerName === provider.name) {
        return provider;
      }
      const existing = routedProviders.get(providerName);
      if (existing !== undefined) {
        return existing;
      }
      const routedProvider = createProvider(
        resolveProviderConfigForProvider(config.workspaceRoot, providerName)
      );
      routedProviders.set(providerName, routedProvider);
      return routedProvider;
    },
    budgetService,
    traceService,
    auditService
  );
  const approvalService = new ApprovalService(storage.approvals, {
    approvalTtlMs: config.approvalTtlMs
  });
  const clarifyService = new ClarifyService(storage.clarifyPrompts, {
    clarifyTtlMs: config.approvalTtlMs
  });
  const approvalRuleStore = new ApprovalRuleStore(config.workspaceRoot);
  const contextPolicy = new ContextPolicy();
  const policyEngine = new PolicyEngine(options.policyConfig ?? DEFAULT_LOCAL_POLICY_CONFIG);
  const agentProfileRegistry = new AgentProfileRegistry();
  const sandboxService = new SandboxService({
    allowedEnvKeys: ["CI", "FORCE_COLOR", "NODE_ENV", "NO_COLOR"],
    allowedFetchHosts: config.allowedFetchHosts,
    ...(config.sandbox.shellAllowlist.length > 0
      ? { allowedShellCommands: config.sandbox.shellAllowlist }
      : {}),
    readRoots: config.sandbox.readRoots,
    shellNetworkAccess: config.sandbox.network === "disabled" ? "disabled" : "unrestricted",
    maxShellTimeoutMs: config.workflow.maxShellTimeoutMs,
    workspaceRoot: config.workspaceRoot,
    writeRoots: config.sandbox.writeRoots
  });
  const shellExecutor =
    config.sandbox.mode === "docker" || config.workflow.shellBackend === "docker-sh"
      ? new DockerShellExecutor({
          dockerImage: config.sandbox.dockerImage ?? "alpine:3.20",
          readRoots: config.sandbox.readRoots,
          workspaceRoot: config.workspaceRoot,
          writeRoots: config.sandbox.writeRoots
        })
      : config.workflow.shellBackend === "custom"
        ? createCustomShellExecutor(config.workflow.customShell)
        : new ShellExecutor({ shellBackend: config.workflow.shellBackend });
  const skillRegistry = new SkillRegistry({
    workspaceRoot: config.workspaceRoot
  });
  const mcpClientManager = new McpClientManager(config.workspaceRoot);
  const sessionMessageSearchService = new SessionMessageSearchService({
    messageRepository: storage.sessionMessages
  });
  const mcpTools = mcpClientManager.discover();
  const skillVersionRegistry = new SkillVersionRegistry(config.workspaceRoot);
  const skillDraftManager = new SkillDraftManager({
    auditService,
    skillVersionRegistry,
    workspaceRoot: config.workspaceRoot
  });
  const skillContextService = new SkillContextService({
    registry: skillRegistry
  });
  const terminalSessionManager = new TerminalSessionManager();
  const todoSessionStore = new TodoSessionStore();
  const delegateTaskTool = new DelegateTaskTool();
  const toolRegistry = new ToolRegistry().registerAll([
    new AskUserTool(),
    new CodeSearchTool(sandboxService),
    delegateTaskTool,
    new GlobTool(sandboxService),
    new PatchTool(sandboxService),
    new ReadFileTool(sandboxService),
    new WriteFileTool(sandboxService),
    new ProcessTool(terminalSessionManager, sandboxService, config.workflow.longRunningCommands),
    new SkillsListTool(skillRegistry),
    new SkillViewTool(skillRegistry),
    new ShellTool(shellExecutor, sandboxService),
    new WebFetchTool(sandboxService),
    new WebSearchTool(sandboxService, config.webSearch),
    new SessionSearchTool({ searchService: sessionMessageSearchService }),
    new TodoTool(todoSessionStore),
    ...mcpTools
  ]);
  const toolOrchestrator = new ToolOrchestrator({
    approvalService,
    approvalRuleStore,
    artifactRepository: storage.artifacts,
    auditService,
    clarifyService,
    contextPolicy,
    policyEngine,
    toolCallRepository: storage.toolCalls,
    toolRegistry,
    traceService
  });
  const memoryPlane = new MemoryPlane({
    contextPolicy,
    memoryRepository: storage.memories,
    memorySnapshotRepository: storage.memorySnapshots,
    traceService
  });
  const experiencePlane = new ExperiencePlane({
    experienceRepository: storage.experiences,
    memoryPlane,
    traceService
  });
  const experienceCollector = new ExperienceCollector({
    experiencePlane,
    traceService
  });
  experienceCollector.start();
  const promotionAdvisor = new PromotionAdvisor({
    auditService,
    config: config.promotion,
    experiencePlane,
    skillDraftManager,
    skillVersionRegistry,
    traceService
  });
  promotionAdvisor.start();
  const recallBudgetPolicy = new RecallBudgetPolicy({
    budgetRatio: config.recall.budgetRatio
  });
  const recallPlanner = new RecallPlanner({
    budgetPolicy: recallBudgetPolicy,
    enabled: config.recall.enabled,
    experiencePlane,
    maxCandidatesPerScope: config.recall.maxCandidatesPerScope,
    memoryPlane,
    sessionSearchService: new SessionSearchService({
      repository: storage.sessionSummaries
    }),
    skillContextService,
    traceService
  });
  const contextCompactor = new ContextCompactor();
  const compactPolicy = new CompactTriggerPolicy();
  const sessionSummaryService = new SessionSummaryService({
    repository: storage.sessionSummaries,
    traceService
  });
  const workerDispatcher = new WorkerDispatcher({
    auditService,
    budgetService,
    traceService
  });
  const summarizerWorker = new SummarizerWorker({
    contextCompactor,
    sessionSummaryService
  });
  const retrievalWorker = new RetrievalWorker({
    recallPlanner
  });
  const deliveryService = new DeliveryService();
  const deliveryProducer = deliveryService.createProducer();
  const inboxService = new InboxService({
    deliveryProducer,
    deliveryProducerKey: deliveryService.producerKey(),
    deliveryService,
    inboxRepository: storage.inbox,
    traceService
  });
  const commitmentService = new CommitmentService({
    commitmentRepository: storage.commitments,
    traceService
  });
  const nextActionService = new NextActionService({
    nextActionRepository: storage.nextActions,
    traceService
  });
  const inboxCollector = new InboxCollector({
    findSchedule: (scheduleId) => storage.schedules.findById(scheduleId),
    findTask: (taskId) => storage.tasks.findById(taskId),
    inboxService,
    listScheduleRunsByTask: (taskId) => storage.scheduleRuns.listByTaskId(taskId),
    nextActionService,
    traceService
  });
  inboxCollector.start();
  const sessionCommitmentProjector = new SessionCommitmentProjector({
    commitmentService,
    nextActionService,
    sessionSummaryService
  });
  const commitmentCollector = new CommitmentCollector({
    commitmentService,
    findTask: (taskId) => storage.tasks.findById(taskId),
    nextActionService,
    sessionSummaryService,
    traceService
  });
  commitmentCollector.start();
  const assistantSessionProjectionService = new AssistantSessionProjectionService({
    commitmentService,
    nextActionService
  });
  const toolOverrideStore = new ToolOverrideStore(config.workspaceRoot);
  const toolExposurePlanner = new ToolExposurePlanner({
    budgetService,
    toolOrchestrator,
    toolOverrideStore,
    traceService
  });
  const sessionService = new SessionService({
    sessionLineageRepository: storage.sessionLineage,
    sessionRepository: storage.sessions,
    sessionTaskRepository: storage.sessionTasks
  });
  const sessionUiStateService = new SessionUiStateService({
    messageRepository: storage.sessionMessages,
    sessionRepository: storage.sessions
  });
  const sessionBranchService = new SessionBranchService({
    sessionLineageRepository: storage.sessionLineage,
    sessionRepository: storage.sessions,
    sessionUiStateService
  });
  const sessionHandoffService = new SessionHandoffService({
    gatewaySessionRepository: storage.gatewaySessions,
    sessionRepository: storage.sessions
  });
  const sessionMessageProjector = new SessionMessageProjector(
    storage.sessionMessages,
    storage.sessions
  );
  const sessionIndexService = new SessionIndexService({
    messageRepository: storage.sessionMessages,
    sessionRepository: storage.sessions
  });

  const executionKernel = new ExecutionKernel({
    compact: config.compact,
    contextRetention: config.contextRetention,
    compactPolicy,
    agentProfileRegistry,
    budgetPricing: config.budget.pricing,
    budgetService,
    executionCheckpointRepository: storage.checkpoints,
    contextCompactor,
    getSessionCommitmentState: (sessionId) => sessionCommitmentProjector.project(sessionId),
    memoryPlane,
    recallPlanner,
    provider,
    providerRouter,
    runMetadataRepository: storage.runMetadata,
    routingMode: config.routing.mode,
    runtimeVersion: config.runtimeVersion,
    sessionSummaryService,
    workerDispatcher,
    summarizerWorker,
    retrievalWorker,
    taskRepository: storage.tasks,
    sessionLineageRepository: storage.sessionLineage,
    sessionTaskRepository: storage.sessionTasks,
    sessionTranscriptRepository: storage.sessionTranscripts,
    sessionMessageProjector,
    toolExposurePlanner,
    toolOrchestrator,
    traceService,
    outputService,
    workflow: config.workflow,
    workspaceRoot: config.workspaceRoot
  });
  delegateTaskTool.bindExecutor(async (request) => {
    const parentTask = storage.tasks.findById(request.parentTaskId);
    const result = await executionKernel.run({
      agentProfileId: request.profile ?? config.defaultProfileId,
      cwd: request.cwd,
      interactionMode: "agent",
      maxIterations: request.maxIterations ?? config.defaultMaxIterations,
      metadata: {
        delegatedFromTaskId: request.parentTaskId
      },
      ...(parentTask?.sessionId !== null && parentTask?.sessionId !== undefined
        ? { sessionId: parentTask.sessionId }
        : {}),
      signal: request.signal,
      taskInput: request.prompt,
      timeoutMs: config.defaultTimeoutMs,
      tokenBudget: {
        ...config.tokenBudget,
        usedCostUsd: 0,
        usedInput: 0,
        usedOutput: 0
      },
      userId: request.userId
    });
    return {
      output: result.output,
      status: result.task.status,
      taskId: result.task.taskId
    };
  });
  const sessionStateProjector = new SessionStateProjector({
    commitmentProjector: sessionCommitmentProjector,
    sessionSummaryService
  });
  const resumePacketBuilder = new ResumePacketBuilder({
    config,
    stateProjector: sessionStateProjector
  });
  let service: AgentApplicationService | null = null;
  const jobRunner = new JobRunner({
    scheduleRepository: storage.schedules,
    scheduleRunRepository: storage.scheduleRuns,
    traceService,
    execute: async ({ run, schedule }) => {
      if (service === null) {
        throw new Error("Application service has not been initialized.");
      }
      const runResult = await service.runTask({
        agentProfileId: schedule.agentProfileId,
        cwd: schedule.cwd,
        maxIterations: config.defaultMaxIterations,
        metadata: {
          scheduleRunContext: {
            disallowScheduleManagement: true,
            runId: run.runId,
            scheduleId: schedule.scheduleId
          }
        },
        taskInput: schedule.input,
        ...(schedule.sessionId !== null ? { sessionId: schedule.sessionId } : {}),
        timeoutMs: config.defaultTimeoutMs,
        tokenBudget: {
          ...config.tokenBudget,
          usedInput: 0,
          usedOutput: 0,
          usedCostUsd: 0
        },
        userId: schedule.ownerUserId
      });
      return runResult;
    }
  });
  const schedulerService = new SchedulerService({
    jobRunner,
    scheduleRepository: storage.schedules,
    scheduleRunRepository: storage.scheduleRuns,
    traceService
  });

  service = new AgentApplicationService({
    customShell: config.workflow.customShell,
    databasePath: config.databasePath,
    executionKernel,
    findArtifact: (artifactId) => storage.artifacts.findById(artifactId),
    findLatestArtifactByType: (artifactType) => storage.artifacts.findLatestByType(artifactType),
    findMemory: (memoryId) => storage.memories.findById(memoryId),
    findExperience: (experienceId) => storage.experiences.findById(experienceId),
    listApprovals: (taskId) => storage.approvals.listByTaskId(taskId),
    listClarifyPrompts: (taskId) => storage.clarifyPrompts.listByTaskId(taskId),
    listArtifacts: (taskId) => storage.artifacts.listByTaskId(taskId),
    listAuditLogs: (taskId) => storage.auditLogs.listByTaskId(taskId),
    listMemories: () => storage.memories.list({ includeExpired: true, includeRejected: true }),
    listExperiences: () => storage.experiences.list(),
    listMemorySnapshots: (scope, scopeKey) => storage.memorySnapshots.listByScope(scope, scopeKey),
    listPendingApprovals: () => approvalService.listPending(),
    listPendingClarifyPrompts: () => clarifyService.listPending(),
    approvalRuleStore,
    approvalService,
    clarifyService,
    findTask: (taskId) => storage.tasks.findById(taskId),
    listTasks: () => storage.tasks.list(),
    findSession: (sessionId) => storage.sessions.findById(sessionId),
    findInboxItem: (inboxId) => storage.inbox.findById(inboxId),
    findSchedule: (scheduleId) => storage.schedules.findById(scheduleId),
    listSessions: () => storage.sessions.list(),
    listSchedules: (query) => storage.schedules.list(query),
    listScheduleRuns: (scheduleId, query) => storage.scheduleRuns.listByScheduleId(scheduleId, query),
    listScheduleRunsByTask: (taskId) => storage.scheduleRuns.listByTaskId(taskId),
    listScheduleRunsBySession: (sessionId) => storage.scheduleRuns.listBySessionId(sessionId),
    listInboxItems: (query) => storage.inbox.list(query),
    listSessionTasks: (sessionId) => storage.sessionTasks.listBySessionId(sessionId),
    listSessionSummaries: (sessionId) => storage.sessionSummaries.listBySession(sessionId),
    searchSessionSummaries: (input) =>
      input.sessionId !== undefined
        ? storage.sessionSummaries.search({
            limit: input.limit,
            query: input.query,
            sessionId: input.sessionId
          })
        : storage.sessionSummaries.searchGlobal({
            excludeSessionId: input.excludeSessionId ?? null,
            limit: input.limit,
            query: input.query
          }),
    findSessionSummary: (sessionSummaryId) => storage.sessionSummaries.findById(sessionSummaryId),
    listSessionLineage: (sessionId) => storage.sessionLineage.listBySessionId(sessionId),
    listToolCalls: (taskId) => storage.toolCalls.listByTaskId(taskId),
    listOutputEvents: (taskId) => storage.outputs.listByTaskId(taskId),
    listSessionOutputEvents: (sessionId) => storage.outputs.listBySessionId(sessionId),
    listTrace: (taskId) => storage.traces.listByTaskId(taskId),
    findExecutionCheckpoint: (taskId) => storage.checkpoints.findByTaskId(taskId),
    saveExecutionCheckpoint: (record) => storage.checkpoints.save(record),
    updateToolCall: (toolCallId, patch) => storage.toolCalls.update(toolCallId, patch),
    allowedFetchHosts: config.allowedFetchHosts,
    provider,
    providerCatalog: options.providerCatalog ?? resolveProviderCatalog(config.workspaceRoot),
    providerConfig: config.provider,
    providerRouter,
    budgetService,
    runtimeConfigPath: config.runtimeConfigPath,
    runtimeConfigSource: config.runtimeConfigSource,
    runtimeVersion: config.runtimeVersion,
    schedulerService,
    resumePacketBuilder,
    sessionService,
    shellBackend: config.workflow.shellBackend,
    tokenBudget: {
      inputLimit: config.tokenBudget.inputLimit,
      outputLimit: config.tokenBudget.outputLimit,
      reservedOutput: config.tokenBudget.reservedOutput
    },
    traceService,
    outputService,
    auditService,
    memoryPlane,
    maxShellTimeoutMs: config.workflow.maxShellTimeoutMs,
    experiencePlane,
    skillDraftManager,
    skillRegistry,
    toolOverrideStore,
    toolRegistry,
    inboxService,
    commitmentService,
    nextActionService,
    sessionCommitmentProjector,
    testCommands: config.workflow.testCommands,
    assistantSessionProjectionService,
    sessionUiStateService,
    sessionIndexService,
    sessionMessageSearchService,
    sessionBranchService,
    sessionHandoffService,
    gatewaySessionRepository: storage.gatewaySessions,
    workspaceRoot: config.workspaceRoot
  });
  if (options.scheduler?.autoStart === true) {
    service.startScheduler();
  }

  return {
    close: () => {
      experienceCollector.stop();
      inboxCollector.stop();
      commitmentCollector.stop();
      promotionAdvisor.stop();
      budgetService.stop();
      service?.stopScheduler();
      void mcpClientManager.close();
      stopOutputTraceProjection();
      storage.close();
    },
    config,
    infrastructure: {
      approvalService,
      auditService,
      createRunOptions: (taskInput: string, cwdForRun: string) =>
        createDefaultRunOptions(taskInput, cwdForRun, config),
      mcpClientManager,
      skillRegistry,
      storage,
      sessionService,
      toolOrchestrator,
      traceService
    },
    service
  };
}

function backupDatabaseIfMigrationNeeded(workspaceRoot: string, databasePath: string): void {
  if (!existsSync(databasePath) || databasePath === ":memory:") {
    return;
  }

  const schemaVersion = readDatabaseSchemaVersion(databasePath);
  if (schemaVersion === null || schemaVersion >= RUNTIME_SCHEMA_VERSION) {
    return;
  }

  const rollbacksDir = join(workspaceRoot, ".auto-talon", "rollbacks");
  mkdirSync(rollbacksDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = join(rollbacksDir, `db-backup-${timestamp}.sqlite`);
  copyFileSync(databasePath, backupPath);
}

function readDatabaseSchemaVersion(databasePath: string): number | null {
  try {
    const db = new DatabaseSync(databasePath);
    const row = db.prepare("PRAGMA user_version").get() as { user_version?: number };
    db.close();
    return row.user_version ?? 0;
  } catch {
    return null;
  }
}

interface SandboxConfigFile {
  defaultProfile?: string;
  profiles?: Record<string, Partial<SandboxProfile>>;
}

function resolveSandboxProfile(
  workspaceRoot: string,
  options: ResolveAppConfigOptions
): SandboxProfile {
  const configPath = join(workspaceRoot, ".auto-talon", "sandbox.config.json");
  const fileConfig = loadSandboxConfigFile(configPath);
  const profileName =
    options.sandboxProfile ??
    process.env.AGENT_SANDBOX_PROFILE ??
    fileConfig.defaultProfile ??
    null;
  const fileProfile =
    profileName !== null && fileConfig.profiles !== undefined
      ? fileConfig.profiles[profileName]
      : undefined;
  const envWriteRoots = splitRootList(process.env.AGENT_WRITE_ROOTS);
  const cliWriteRoots = options.writeRoots ?? [];
  const mode =
    options.sandboxMode ??
    parseSandboxMode(process.env.AGENT_SANDBOX_MODE) ??
    fileProfile?.mode ??
    "local";
  const writeRoots = normalizeRootList([
    workspaceRoot,
    ...(fileProfile?.writeRoots ?? []),
    ...envWriteRoots,
    ...cliWriteRoots
  ]);

  return {
    configPath: existsSync(configPath) ? configPath : null,
    configSource:
      options.sandboxMode !== undefined || options.sandboxProfile !== undefined || cliWriteRoots.length > 0
        ? "cli"
        : process.env.AGENT_SANDBOX_MODE !== undefined ||
            process.env.AGENT_SANDBOX_PROFILE !== undefined ||
            process.env.AGENT_WRITE_ROOTS !== undefined ||
            process.env.AGENT_DOCKER_IMAGE !== undefined
          ? "env"
          : fileProfile !== undefined
            ? "file"
            : "defaults",
    dockerImage:
      process.env.AGENT_DOCKER_IMAGE ??
      fileProfile?.dockerImage ??
      null,
    mode,
    network: fileProfile?.network === "controlled" ? "controlled" : "disabled",
    profileName,
    readRoots: normalizeRootList([
      workspaceRoot,
      ...(fileProfile?.readRoots ?? []),
      ...writeRoots
    ]),
    shellAllowlist: fileProfile?.shellAllowlist ?? [],
    workspaceRoot,
    writeRoots
  };
}

function loadSandboxConfigFile(configPath: string): SandboxConfigFile {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf8").trim();
  if (content.length === 0) {
    return {};
  }

  return JSON.parse(content) as SandboxConfigFile;
}

function splitRootList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }

  return value
    .split(delimiter)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeRootList(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => resolve(entry)))];
}

function parseSandboxMode(value: string | undefined): SandboxMode | undefined {
  if (value === "local" || value === "docker") {
    return value;
  }

  return undefined;
}

export function createDefaultRunOptions(
  taskInput: string,
  cwd: string,
  config: AppConfig
): RuntimeRunOptions {
  return {
    agentProfileId: config.defaultProfileId,
    cwd,
    maxIterations: config.defaultMaxIterations,
    taskInput,
    timeoutMs: config.defaultTimeoutMs,
    tokenBudget: config.tokenBudget,
    userId: process.env.USERNAME ?? process.env.USER ?? "local-user"
  };
}
