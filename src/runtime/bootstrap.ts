import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

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
  type ProviderCatalogEntry,
  type ResolvedProviderConfig
} from "../providers/index.js";
import { SandboxService } from "../sandbox/sandbox-service.js";
import { SkillContextService, SkillDraftManager, SkillRegistry } from "../skills/index.js";
import { SkillVersionRegistry } from "../skills/versioning/index.js";
import { StorageManager } from "../storage/database.js";
import { migrateConfigFiles, validateConfigVersions } from "../storage/config-migration.js";
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
import { AskUserTool, FileReadTool, FileWriteTool, ShellTool, SkillViewTool, TestRunTool, ToolOrchestrator, WebFetchTool } from "../tools/index.js";
import { DockerShellExecutor } from "../tools/shell/docker-shell-executor.js";
import { ShellExecutor } from "../tools/shell/shell-executor.js";

import { AgentApplicationService } from "./application-service.js";
import { ContextCompactor, SessionSearchService, ThreadSessionMemoryService } from "./context/index.js";
import { BudgetService } from "./budget/index.js";
import { ExecutionKernel } from "./execution-kernel.js";
import { RecallBudgetPolicy, RecallPlanner } from "./retrieval/index.js";
import { DeliveryService } from "./delivery/index.js";
import { InboxCollector, InboxService } from "./inbox/index.js";
import {
  AssistantThreadProjectionService,
  CommitmentCollector,
  CommitmentService,
  NextActionService,
  ThreadCommitmentProjector
} from "./commitments/index.js";
import { JobRunner } from "./jobs/index.js";
import { SchedulerService } from "./scheduler/index.js";
import { ResumePacketBuilder, ThreadService, ThreadStateProjector } from "./threads/index.js";
import { RetrievalWorker, SummarizerWorker, WorkerDispatcher } from "./workers/index.js";
import { resolveRuntimeConfig, type WorkflowRuntimeConfig } from "./runtime-config.js";
import { ToolExposurePlanner } from "./tool-exposure-planner.js";
import { initializeWorkspaceFiles } from "./workspace-setup.js";

export interface AppConfig {
  approvalTtlMs: number;
  allowedFetchHosts: string[];
  databasePath: string;
  defaultMaxIterations: number;
  defaultProfileId: "executor" | "planner" | "reviewer";
  defaultTimeoutMs: number;
  compact: {
    messageThreshold: number;
    tokenThreshold: number;
    toolCallThreshold: number;
    summarizer: "deterministic" | "provider_subagent";
  };
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
    thread: BudgetLimits;
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
  workflow: WorkflowRuntimeConfig;
  workspaceRoot: string;
}

export interface ResolveAppConfigOptions {
  sandboxMode?: SandboxMode;
  sandboxProfile?: string;
  writeRoots?: string[];
}

export function resolveAppConfig(cwd = process.cwd(), options: ResolveAppConfigOptions = {}): AppConfig {
  const workspaceRoot = resolve(process.env.AGENT_WORKSPACE_ROOT ?? cwd);
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
    recall: runtimeConfig.recall,
    promotion: runtimeConfig.promotion,
    routing: runtimeConfig.routing,
    budget: runtimeConfig.budget,
    provider,
    runtimeVersion: "0.1.0",
    runtimeConfigPath: runtimeConfig.configPath,
    runtimeConfigSource: runtimeConfig.configSource,
    sandbox,
    tokenBudget: runtimeConfig.tokenBudget,
    workflow: runtimeConfig.workflow,
    workspaceRoot
  };
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
    threadService: ThreadService;
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
  backupDatabaseIfPresent(resolvedConfig.workspaceRoot, resolvedConfig.databasePath);
  const configuredWorkspaceRoot = options.config?.workspaceRoot ?? resolvedConfig.workspaceRoot;
  const resolvedSandbox =
    configuredWorkspaceRoot === resolvedConfig.workspaceRoot
      ? resolvedConfig.sandbox
      : resolveSandboxProfile(configuredWorkspaceRoot, options.sandbox ?? {});
  const config = {
    ...resolvedConfig,
    ...options.config,
    sandbox: {
      ...resolvedSandbox,
      ...options.config?.sandbox
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
  const auditService = new AuditService(storage.auditLogs);
  const budgetService = new BudgetService(config.budget, traceService, auditService);
  budgetService.start();
  const providerRouter = new ProviderRouter(
    config.routing,
    (providerName) => {
      if (providerName === provider.name) {
        return provider;
      }
      return provider;
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
    maxShellTimeoutMs: 30_000,
    workspaceRoot: config.workspaceRoot,
    writeRoots: config.sandbox.writeRoots
  });
  const shellExecutor =
    config.sandbox.mode === "docker"
      ? new DockerShellExecutor({
          dockerImage: config.sandbox.dockerImage ?? "alpine:3.20",
          readRoots: config.sandbox.readRoots,
          workspaceRoot: config.workspaceRoot,
          writeRoots: config.sandbox.writeRoots
        })
      : new ShellExecutor();
  const skillRegistry = new SkillRegistry({
    workspaceRoot: config.workspaceRoot
  });
  const mcpClientManager = new McpClientManager(config.workspaceRoot);
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
  const toolOrchestrator = new ToolOrchestrator({
    approvalService,
    approvalRuleStore,
    artifactRepository: storage.artifacts,
    auditService,
    clarifyService,
    contextPolicy,
    policyEngine,
    toolCallRepository: storage.toolCalls,
    tools: [
      new AskUserTool(),
      new FileReadTool(sandboxService),
      new FileWriteTool(sandboxService),
      new SkillViewTool(skillRegistry),
      new ShellTool(shellExecutor, sandboxService),
      new TestRunTool(
        shellExecutor,
        sandboxService,
        config.workflow.testCommands,
        config.workflow.failureGuidedRetry.maxRepairAttempts
      ),
      new WebFetchTool(sandboxService),
      ...mcpTools
    ],
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
      repository: storage.threadSessionMemories
    }),
    skillContextService,
    traceService
  });
  const contextCompactor = new ContextCompactor();
  const compactPolicy = new CompactTriggerPolicy();
  const threadSessionMemoryService = new ThreadSessionMemoryService({
    repository: storage.threadSessionMemories,
    traceService
  });
  const workerDispatcher = new WorkerDispatcher({
    auditService,
    budgetService,
    traceService
  });
  const summarizerWorker = new SummarizerWorker({
    contextCompactor,
    threadSessionMemoryService
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
  const threadCommitmentProjector = new ThreadCommitmentProjector({
    commitmentService,
    nextActionService,
    threadSessionMemoryService
  });
  const commitmentCollector = new CommitmentCollector({
    commitmentService,
    findTask: (taskId) => storage.tasks.findById(taskId),
    nextActionService,
    threadSessionMemoryService,
    traceService
  });
  commitmentCollector.start();
  const assistantThreadProjectionService = new AssistantThreadProjectionService({
    commitmentService,
    nextActionService
  });
  const toolExposurePlanner = new ToolExposurePlanner({
    budgetService,
    toolOrchestrator,
    traceService
  });

  const executionKernel = new ExecutionKernel({
    compact: config.compact,
    compactPolicy,
    agentProfileRegistry,
    budgetPricing: config.budget.pricing,
    budgetService,
    executionCheckpointRepository: storage.checkpoints,
    contextCompactor,
    getThreadCommitmentState: (threadId) => threadCommitmentProjector.project(threadId),
    memoryPlane,
    recallPlanner,
    provider,
    providerRouter,
    runMetadataRepository: storage.runMetadata,
    routingMode: config.routing.mode,
    runtimeVersion: config.runtimeVersion,
    threadSessionMemoryService,
    workerDispatcher,
    summarizerWorker,
    retrievalWorker,
    taskRepository: storage.tasks,
    threadLineageRepository: storage.threadLineage,
    threadRunRepository: storage.threadRuns,
    toolExposurePlanner,
    toolOrchestrator,
    traceService,
    workflow: config.workflow,
    workspaceRoot: config.workspaceRoot
  });
  const threadService = new ThreadService({
    threadLineageRepository: storage.threadLineage,
    threadRepository: storage.threads,
    threadRunRepository: storage.threadRuns
  });
  const threadStateProjector = new ThreadStateProjector({
    commitmentProjector: threadCommitmentProjector,
    threadSessionMemoryService
  });
  const resumePacketBuilder = new ResumePacketBuilder({
    config,
    stateProjector: threadStateProjector
  });
  let service: AgentApplicationService | null = null;
  const jobRunner = new JobRunner({
    scheduleRepository: storage.schedules,
    scheduleRunRepository: storage.scheduleRuns,
    traceService,
    execute: async ({ schedule }) => {
      if (service === null) {
        throw new Error("Application service has not been initialized.");
      }
      const runResult = await service.runTask({
        agentProfileId: schedule.agentProfileId,
        cwd: schedule.cwd,
        maxIterations: config.defaultMaxIterations,
        taskInput: schedule.input,
        ...(schedule.threadId !== null ? { threadId: schedule.threadId } : {}),
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
    findThread: (threadId) => storage.threads.findById(threadId),
    findInboxItem: (inboxId) => storage.inbox.findById(inboxId),
    findSchedule: (scheduleId) => storage.schedules.findById(scheduleId),
    listThreads: () => storage.threads.list(),
    listSchedules: (query) => storage.schedules.list(query),
    listScheduleRuns: (scheduleId, query) => storage.scheduleRuns.listByScheduleId(scheduleId, query),
    listScheduleRunsByTask: (taskId) => storage.scheduleRuns.listByTaskId(taskId),
    listScheduleRunsByThread: (threadId) => storage.scheduleRuns.listByThreadId(threadId),
    listInboxItems: (query) => storage.inbox.list(query),
    listThreadRuns: (threadId) => storage.threadRuns.listByThreadId(threadId),
    listThreadSessionMemories: (threadId) => storage.threadSessionMemories.listByThread(threadId),
    searchThreadSessionMemories: (input) =>
      input.threadId !== undefined
        ? storage.threadSessionMemories.search({
            limit: input.limit,
            query: input.query,
            threadId: input.threadId
          })
        : storage.threadSessionMemories.searchGlobal({
            excludeThreadId: input.excludeThreadId ?? null,
            limit: input.limit,
            query: input.query
          }),
    findThreadSessionMemory: (sessionMemoryId) => storage.threadSessionMemories.findById(sessionMemoryId),
    listThreadLineage: (threadId) => storage.threadLineage.listByThreadId(threadId),
    listToolCalls: (taskId) => storage.toolCalls.listByTaskId(taskId),
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
    threadService,
    tokenBudget: {
      inputLimit: config.tokenBudget.inputLimit,
      outputLimit: config.tokenBudget.outputLimit,
      reservedOutput: config.tokenBudget.reservedOutput
    },
    traceService,
    auditService,
    memoryPlane,
    experiencePlane,
    skillDraftManager,
    skillRegistry,
    inboxService,
    commitmentService,
    nextActionService,
    threadCommitmentProjector,
    assistantThreadProjectionService,
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
      threadService,
      toolOrchestrator,
      traceService
    },
    service
  };
}

function backupDatabaseIfPresent(workspaceRoot: string, databasePath: string): void {
  if (!existsSync(databasePath) || databasePath === ":memory:") {
    return;
  }

  const rollbacksDir = join(workspaceRoot, ".auto-talon", "rollbacks");
  mkdirSync(rollbacksDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupPath = join(rollbacksDir, `db-backup-${timestamp}.sqlite`);
  copyFileSync(databasePath, backupPath);
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
