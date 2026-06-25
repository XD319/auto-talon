import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ApprovalRuleStore } from "../approvals/approval-rule-store.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import type { ClarifyService } from "../approvals/clarify-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type {
  ExperiencePlane,
  ExperiencePromoteResult,
  ExperienceReviewRequest
} from "../experience/experience-plane.js";
import {
  isProviderSwitchable,
  resolveProviderConfig,
  type ProviderCatalogEntry,
  type ResolvedProviderConfig
} from "../providers/index.js";
import type { AuxiliaryProviderResolver } from "../providers/auxiliary-resolver.js";
import { clearFallbackProviderCache } from "../providers/provider-failover.js";
import type { ProviderRouter } from "../providers/routing/provider-router.js";
import {
  resolveRuntimeConfig,
  type RuntimeConfig,
  type ShellBackend,
  type WorkflowCustomShell,
  type WorkflowTestCommand
} from "./runtime-config.js";
import type { BudgetService } from "./budget/budget-service.js";
import type {
  ApprovalRecord,
  ApprovalAllowScope,
  ArtifactRecord,
  AuditLogRecord,
  ClarifyPromptRecord,
  CommitmentDraft,
  CommitmentListQuery,
  CommitmentRecord,
  ContextFragment,
  ExecutionCheckpointRecord,
  ExperienceQuery,
  ExperienceRecord,
  InboxDeliveryEvent,
  InboxItem,
  GatewaySessionRepository,
  JsonValue,
  InboxListQuery,
  JsonObject,
  MemoryRecord,
  MemoryScope,
  MemorySnapshotRecord,
  Provider,
  ProviderStatsSnapshot,
  ProviderHealthCheck,
  RuntimeOutputEvent,
  RuntimeRunOptions,
  NextActionDraft,
  NextActionRecord,
  NextActionListQuery,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  SessionMessageRepository,
  SessionSearchHit,
  SessionLineageRepository,
  TaskRecord,
  SessionLineageRecord,
  SessionRecord,
  SessionTaskRecord,
  SessionSummaryRecord,
  SessionCommitmentState,
  SessionIndexEntry,
  SessionMessageSearchHit,
  SessionListQuery,
  SessionUiState,
  TokenBudget,
  TraceEvent,
  ToolCallRecord
} from "../types/index.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { RuntimeOutputService } from "./runtime-output-service.js";
import type { MemoryPlane } from "../memory/memory-plane.js";
import type { SkillAttachmentKind } from "../types/skill.js";
import type { SkillDraftManager, SkillRegistry } from "../skills/index.js";
import type { TodoItem, TodoSessionStore } from "../tools/todo-session-store.js";
import type { ToolOverrideStore } from "../tools/tool-overrides.js";
import type { ToolRegistry } from "../tools/tool-registry.js";
import type { ExecutionKernel } from "./execution-kernel.js";
import type { ResumePacketBuilder, SessionService } from "./sessions/index.js";
import type {
  SessionUiStateService,
  SaveSessionUiStateInput
} from "./sessions/session-ui-state-service.js";
import type { SessionIndexService } from "./sessions/session-index-service.js";
import type { SessionMessageSearchService } from "./sessions/session-message-search-service.js";
import type { SessionBranchService } from "./sessions/session-branch-service.js";
import type { SessionHandoffService, SessionHandoffRequest } from "./sessions/session-handoff-service.js";
import { resolveSessionRef, type ResolveSessionRefResult } from "./sessions/session-resolver.js";
import type { TranscriptMigrationResult } from "./sessions/transcript-migrator.js";
import { migrateLegacyTranscriptFiles } from "./sessions/transcript-migrator.js";
import type { CreateScheduleInput, SchedulerService, UpdateScheduleInput } from "./scheduler/index.js";
import type { InboxService } from "./inbox/index.js";
import type {
  AssistantSessionProjectionService,
  CommitmentService,
  NextActionService,
  SessionCommitmentProjector
} from "./commitments/index.js";
import { FileRollbackService, ProviderStatsService, RuntimeDoctorService } from "./operations/index.js";
import {
  formatProviderSelection,
  listConfiguredProviders,
  switchProviderRuntime,
  type ConfiguredProviderEntry,
  type ProviderSwitchPersistScope,
  type SwitchProviderResult
} from "./operations/provider-switch-service.js";
import {
  createModelSelectionView,
  readSessionModelSelection,
  withSessionModelSelection,
  withoutSessionModelSelection,
  type ModelSelectionView
} from "./operations/model-selection-service.js";
import type { ContextCompactor, SessionSummaryService } from "./context/index.js";
import { SessionFacade } from "./facades/index.js";

import { AppError, toAppError } from "./app-error.js";

export interface RunTaskResult {
  error?: AppError;
  output: string | null;
  task: TaskRecord;
}

export interface ApprovalActionResult {
  approval: ApprovalRecord;
  error?: AppError;
  output: string | null;
  task: TaskRecord;
}

export interface ClarifyActionResult {
  error?: AppError;
  output: string | null;
  prompt: ClarifyPromptRecord;
  task: TaskRecord;
}

export interface AgentDoctorReport {
  apiKeyConfigured: boolean;
  configPath: string;
  configSource: "defaults" | "env" | "file" | "user";
  databasePath: string;
  endpointReachable: boolean | null;
  experienceStats: {
    accepted: number;
    candidate: number;
    promoted: number;
    rejected: number;
    stale: number;
    total: number;
  };
  issues: string[];
  allowedFetchHosts: string[];
  maxRetries: number;
  modelAvailable: boolean | null;
  modelConfigured: boolean;
  modelName: string | null;
  nodeVersion: string;
  pnpmVersion: string | null;
  corepackAvailable: boolean;
  providerHealthMessage: string;
  providerName: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  runtimeVersion: string;
  configFiles: Array<{ exists: boolean; file: string; parseable: boolean }>;
  workspaceSecretFindings: Array<{ file: string; fields: string[] }>;
  databaseReachable: boolean;
  distFresh: boolean | null;
  schemaVersion: number | null;
  shell: string | undefined;
  shellBackend: ShellBackend;
  shellBackendAvailable: boolean;
  shellExecutable: string;
  shellMaxTimeoutMs: number;
  skillStats: {
    enabled: number;
    issues: number;
    total: number;
  };
  tokenBudget: {
    inputLimit: number;
    outputLimit: number;
    reservedOutput: number;
  };
  timeoutMs: number;
  streamIdleTimeoutMs: number;
  workspaceRoot: string;
  providerRouter?: ProviderRouter;
  budgetService?: BudgetService;
}

export interface ContextTraceDebugReport {
  contextAssembly: Extract<TraceEvent, { eventType: "context_assembled" }>["payload"]["debugView"] | null;
  memoryRecall:
    | Extract<TraceEvent, { eventType: "memory_recalled" }>["payload"]
    | null;
  reviewerTrace:
    | Extract<TraceEvent, { eventType: "reviewer_trace" }>["payload"]
    | null;
  latestSessionSummary:
    | Extract<TraceEvent, { eventType: "session_summary_written" }>["payload"]
    | null;
  task: TaskRecord | null;
}

export interface RollbackFileArtifactResult {
  artifact: ArtifactRecord;
  deleted: boolean;
  path: string;
  restored: boolean;
}

export interface RuntimeReadModel {
  findExperience(experienceId: string): ExperienceRecord | null;
  findArtifact(artifactId: string): ArtifactRecord | null;
  findLatestArtifactByType(artifactType: string): ArtifactRecord | null;
  findMemory(memoryId: string): MemoryRecord | null;
  findTask(taskId: string): TaskRecord | null;
  listApprovals(taskId: string): ApprovalRecord[];
  listClarifyPrompts(taskId: string): ClarifyPromptRecord[];
  listArtifacts(taskId: string): ArtifactRecord[];
  listAuditLogs(taskId: string): AuditLogRecord[];
  listExperiences(): ExperienceRecord[];
  listMemorySnapshots(scope: MemoryScope, scopeKey: string): MemorySnapshotRecord[];
  listPendingApprovals(): ApprovalRecord[];
  listPendingClarifyPrompts(): ClarifyPromptRecord[];
  listMemories(): MemoryRecord[];
  listTasks(): TaskRecord[];
  listSessionLineage(sessionId: string): SessionLineageRecord[];
  listSessionTasks(sessionId: string): SessionTaskRecord[];
  listSessionSummaries(sessionId: string): SessionSummaryRecord[];
  searchSessionSummaries(input: {
    limit: number;
    query: string;
    sessionId?: string;
    excludeSessionId?: string | null;
  }): SessionSearchHit[];
  findSessionSummary(sessionSummaryId: string): SessionSummaryRecord | null;
  listSchedules(query?: ScheduleListQuery): ScheduleRecord[];
  findSchedule(scheduleId: string): ScheduleRecord | null;
  listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listScheduleRunsByTask(taskId: string): ScheduleRunRecord[];
  listScheduleRunsBySession(sessionId: string): ScheduleRunRecord[];
  listInboxItems(query?: InboxListQuery): InboxItem[];
  findInboxItem(inboxId: string): InboxItem | null;
  listSessions(): SessionRecord[];
  findSession(sessionId: string): SessionRecord | null;
  listToolCalls(taskId: string): ToolCallRecord[];
  listOutputEvents(taskId: string): RuntimeOutputEvent[];
  listSessionOutputEvents(sessionId: string): RuntimeOutputEvent[];
  listTrace(taskId: string): TraceEvent[];
  findExecutionCheckpoint(taskId: string): ExecutionCheckpointRecord | null;
  saveExecutionCheckpoint(record: ExecutionCheckpointRecord): ExecutionCheckpointRecord;
  updateToolCall(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord;
}

export interface ProviderSmokeReport {
  errorCategory: string | null;
  latencyMs: number;
  message: string;
  modelName: string | null;
  ok: boolean;
  providerName: string;
  streamIdleTimeoutMs: number;
  timeoutMs: number;
}

export interface AgentApplicationServiceDependencies extends RuntimeReadModel {
  approvalRuleStore: ApprovalRuleStore;
  approvalService: ApprovalService;
  auditService: AuditService;
  clarifyService: ClarifyService;
  customShell: WorkflowCustomShell | null;
  databasePath: string;
  executionKernel: ExecutionKernel;
  contextCompactor: ContextCompactor;
  compact: RuntimeConfig["compact"];
  schedulerService: SchedulerService;
  resumePacketBuilder: ResumePacketBuilder;
  sessionSummaryService: SessionSummaryService;
  sessionService: SessionService;
  experiencePlane: ExperiencePlane;
  maxShellTimeoutMs: number;
  memoryPlane: MemoryPlane;
  provider: Provider;
  providerCatalog: ProviderCatalogEntry[];
  providerConfig: ResolvedProviderConfig;
  allowedFetchHosts: string[];
  runtimeVersion: string;
  runtimeConfigPath: string;
  runtimeConfigSource: "defaults" | "env" | "file";
  skillDraftManager: SkillDraftManager;
  skillRegistry: SkillRegistry;
  todoSessionStore: TodoSessionStore;
  toolOverrideStore: ToolOverrideStore;
  toolRegistry: ToolRegistry;
  shellBackend: ShellBackend;
  inboxService: InboxService;
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
  sessionCommitmentProjector: SessionCommitmentProjector;
  tokenBudget: TokenBudget;
  tokenBudgetInputLimitExplicit: boolean;
  traceService: TraceService;
  testCommands: WorkflowTestCommand[];
  outputService: RuntimeOutputService;
  assistantSessionProjectionService: AssistantSessionProjectionService;
  sessionUiStateService: SessionUiStateService;
  sessionIndexService: SessionIndexService;
  sessionMessageSearchService: SessionMessageSearchService;
  sessionMessageRepository: SessionMessageRepository;
  sessionLineageRepository: SessionLineageRepository;
  sessionBranchService: SessionBranchService;
  sessionHandoffService: SessionHandoffService;
  gatewaySessionRepository: GatewaySessionRepository;
  providerRouter?: ProviderRouter;
  auxiliaryProviderResolver?: AuxiliaryProviderResolver;
  budgetService?: BudgetService;
  workspaceRoot: string;
}

export interface TaskTimelineEntry {
  actor: string;
  detail: string;
  eventType: TraceEvent["eventType"];
  iteration: number | null;
  sequence: number;
  stage: TraceEvent["stage"];
  timestamp: string;
}

export interface TaskTimelineReport {
  entries: TaskTimelineEntry[];
  task: TaskRecord | null;
}

const approvalActionSchema = z.object({
  action: z.enum(["allow", "deny"]),
  allowScope: z.enum(["once", "session", "always"]).optional(),
  approvalId: z.string().min(1),
  reviewerId: z.string().min(1)
});

const clarifyAnswerSchema = z
  .object({
    answerOptionId: z.string().min(1).optional(),
    answerText: z.string().min(1).optional(),
    answers: z.record(z.string().min(1), z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).optional(),
    response: z.string().min(1).optional(),
    promptId: z.string().min(1),
    reviewerId: z.string().min(1)
  })
  .refine(
    (value) =>
      value.answerOptionId !== undefined ||
      value.answerText !== undefined ||
      value.answers !== undefined ||
      value.response !== undefined,
    {
      message: "answerOptionId, answerText, answers, or response is required."
    }
  );

export class AgentApplicationService {
  private readonly sessionFacade: SessionFacade;
  private readonly approvalFailureContinuations = new Map<string, Promise<ApprovalActionResult>>();
  private switchProviderInFlight: Promise<SwitchProviderResult> | null = null;

  public constructor(private readonly dependencies: AgentApplicationServiceDependencies) {
    this.sessionFacade = new SessionFacade(
      dependencies,
      (sessionId, taskId, output) => this.projectAssistantOutput(sessionId, taskId, output)
    );
  }

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    return this.sessionFacade.runTask(options);
  }

  public listTasks(): TaskRecord[] {
    return this.sessionFacade.listTasks();
  }

  public createSession(input: {
    agentProfileId: SessionRecord["agentProfileId"];
    cwd: string;
    metadata?: JsonObject;
    ownerUserId: string;
    providerName?: string;
    title?: string;
  }): SessionRecord {
    return this.sessionFacade.createSession(input);
  }

  public loadSessionUiState(sessionId: string): SessionUiState | null {
    return this.dependencies.sessionUiStateService.load(sessionId);
  }

  public getSessionTodos(sessionId: string): TodoItem[] {
    return this.dependencies.todoSessionStore.get(sessionId);
  }

  public saveSessionUiState(sessionId: string, input: SaveSessionUiStateInput): void {
    this.dependencies.sessionUiStateService.save(sessionId, input);
  }

  public updateSessionTitle(sessionId: string, title: string): SessionRecord {
    return this.dependencies.sessionService.updateTitle(sessionId, title);
  }

  public resolveSessionRef(ref: string, ownerUserId: string): ResolveSessionRefResult {
    return resolveSessionRef(ref, ownerUserId, this.listSessions());
  }

  public branchSession(input: {
    agentProfileId: SessionRecord["agentProfileId"];
    cwd: string;
    ownerUserId: string;
    providerName?: string;
    sourceSessionId: string;
    title?: string;
  }): SessionRecord {
    return this.dependencies.sessionBranchService.branch({
      agentProfileId: input.agentProfileId,
      cwd: input.cwd,
      ownerUserId: input.ownerUserId,
      providerName: input.providerName ?? this.dependencies.provider.name,
      sourceSessionId: input.sourceSessionId,
      ...(input.title !== undefined ? { title: input.title } : {})
    });
  }

  public handoffSession(request: SessionHandoffRequest) {
    return this.dependencies.sessionHandoffService.handoff(request);
  }

  public rebindGatewaySession(input: {
    adapterId: string;
    externalSessionId: string;
    externalUserId?: string | null;
    ownerUserId: string;
    runtimeSessionId: string;
    runtimeUserId: string;
  }) {
    return this.dependencies.sessionHandoffService.rebindExternalSession(input);
  }

  public resolveGatewayRuntimeSessionId(adapterId: string, externalSessionId: string): string | null {
    const latest = this.dependencies.gatewaySessionRepository.findLatestByExternalSession(
      adapterId,
      externalSessionId
    );
    return latest?.runtimeSessionId ?? null;
  }

  public listGatewayBindingsForRuntimeSession(runtimeSessionId: string) {
    return this.dependencies.sessionHandoffService.listBindingsForSession(runtimeSessionId);
  }

  public listSessionIndex(query?: SessionListQuery): SessionIndexEntry[] {
    return this.dependencies.sessionIndexService.list(query);
  }

  public latestSessionIndexForUser(ownerUserId: string): SessionIndexEntry | null {
    return this.dependencies.sessionIndexService.latestForUser(ownerUserId);
  }

  public searchSessionMessages(input: {
    limit?: number;
    query: string;
    sessionIdPrefix?: string;
  }): SessionMessageSearchHit[] {
    return this.dependencies.sessionMessageSearchService.search(input);
  }

  public async migrateLegacyTranscripts(): Promise<TranscriptMigrationResult> {
    return migrateLegacyTranscriptFiles({
      sessionRepository: {
        create: (draft) => this.dependencies.sessionService.createSession(draft),
        findById: (sessionId) => this.findSession(sessionId)
      },
      sessionUiStateService: this.dependencies.sessionUiStateService,
      workspaceRoot: this.dependencies.workspaceRoot
    });
  }

  public listSessions(status?: SessionRecord["status"]): SessionRecord[] {
    return this.sessionFacade.listSessions(status);
  }

  public findSession(sessionId: string): SessionRecord | null {
    return this.dependencies.findSession(sessionId);
  }

  public showSession(sessionId: string): {
    commitments: CommitmentRecord[];
    inboxItems: InboxItem[];
    nextActions: NextActionRecord[];
    state: SessionCommitmentState;
    session: SessionRecord | null;
    tasks: SessionTaskRecord[];
    lineage: SessionLineageRecord[];
    scheduleRuns: ScheduleRunRecord[];
  } {
    return this.sessionFacade.showSession(sessionId);
  }

  public archiveSession(sessionId: string): SessionRecord {
    return this.sessionFacade.archiveSession(sessionId);
  }

  public listSessionSummaries(sessionId: string): SessionSummaryRecord[] {
    return this.sessionFacade.listSessionSummaries(sessionId);
  }

  public showSessionSummary(snapshotId: string): SessionSummaryRecord | null {
    return this.sessionFacade.showSessionSummary(snapshotId);
  }

  public searchSessionSummaries(input: {
    limit: number;
    query: string;
    sessionId?: string;
    excludeSessionId?: string | null;
  }): SessionSearchHit[] {
    return this.sessionFacade.searchSessionSummaries(input);
  }

  public ensureRuntimeSession(
    sessionId: string,
    input?: {
      agentProfileId?: SessionRecord["agentProfileId"];
      cwd?: string;
      ownerUserId?: string;
      title?: string;
    }
  ): SessionRecord {
    return this.sessionFacade.ensureRuntimeSession(sessionId, input);
  }

  public async continueSession(
    sessionId: string,
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    return this.sessionFacade.continueSession(sessionId, input, overrides);
  }

  public async continueLatest(
    input: string | undefined,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    return this.sessionFacade.continueLatest(input, overrides);
  }

  public listCommitments(query: CommitmentListQuery = {}): CommitmentRecord[] {
    return this.dependencies.commitmentService.list(query);
  }

  public showCommitment(commitmentId: string): CommitmentRecord | null {
    return this.dependencies.commitmentService.get(commitmentId);
  }

  public createCommitment(draft: CommitmentDraft): CommitmentRecord {
    return this.dependencies.commitmentService.create(draft);
  }

  public updateCommitment(commitmentId: string, patch: Parameters<CommitmentService["update"]>[1]): CommitmentRecord {
    return this.dependencies.commitmentService.update(commitmentId, patch);
  }

  public blockCommitment(commitmentId: string, reason: string): CommitmentRecord {
    return this.dependencies.commitmentService.block(commitmentId, reason);
  }

  public unblockCommitment(commitmentId: string): CommitmentRecord {
    return this.dependencies.commitmentService.unblock(commitmentId);
  }

  public completeCommitment(commitmentId: string): CommitmentRecord {
    return this.dependencies.commitmentService.complete(commitmentId);
  }

  public cancelCommitment(commitmentId: string): CommitmentRecord {
    return this.dependencies.commitmentService.cancel(commitmentId);
  }

  public listNextActions(query: NextActionListQuery = {}): NextActionRecord[] {
    return this.dependencies.nextActionService.list(query);
  }

  public appendNextAction(draft: NextActionDraft): NextActionRecord {
    return this.dependencies.nextActionService.create(draft);
  }

  public markNextActionDone(nextActionId: string): NextActionRecord {
    return this.dependencies.nextActionService.markDone(nextActionId);
  }

  public blockNextAction(nextActionId: string, reason: string): NextActionRecord {
    return this.dependencies.nextActionService.block(nextActionId, reason);
  }

  public unblockNextAction(nextActionId: string): NextActionRecord {
    return this.dependencies.nextActionService.unblock(nextActionId);
  }

  public cancelNextAction(nextActionId: string): NextActionRecord {
    return this.dependencies.nextActionService.cancel(nextActionId);
  }

  public reorderNextActions(sessionId: string, orderedIds: string[]): NextActionRecord[] {
    return this.dependencies.nextActionService.reorder(sessionId, orderedIds);
  }

  public listMemories(): MemoryRecord[] {
    return this.dependencies.listMemories();
  }

  public listExperiences(query?: ExperienceQuery): ExperienceRecord[] {
    return this.dependencies.experiencePlane.list(query);
  }

  public showExperience(experienceId: string): ExperienceRecord | null {
    return this.dependencies.experiencePlane.show(experienceId);
  }

  public reviewExperience(request: ExperienceReviewRequest): ExperienceRecord {
    return this.dependencies.experiencePlane.review(request);
  }

  public promoteExperience(
    request: Parameters<ExperiencePlane["promote"]>[0]
  ): ExperiencePromoteResult {
    return this.dependencies.experiencePlane.promote(request);
  }

  public searchExperiences(query: string, filters: ExperienceQuery = {}) {
    return this.dependencies.experiencePlane.search(query, filters);
  }

  public listSkills() {
    return this.dependencies.skillRegistry.listSkills();
  }

  public viewSkill(skillId: string, attachmentKinds: SkillAttachmentKind[] = []) {
    return this.dependencies.skillRegistry.viewSkill(skillId, attachmentKinds);
  }

  public enableSkill(skillId: string) {
    return this.dependencies.skillRegistry.enableSkill(skillId);
  }

  public disableSkill(skillId: string) {
    return this.dependencies.skillRegistry.disableSkill(skillId);
  }

  public listTools() {
    return this.dependencies.toolOverrideStore.listTools(this.dependencies.toolRegistry.list());
  }

  public enableTool(toolName: string) {
    return this.dependencies.toolOverrideStore.enableTool(toolName, this.dependencies.toolRegistry.list());
  }

  public disableTool(toolName: string) {
    return this.dependencies.toolOverrideStore.disableTool(toolName, this.dependencies.toolRegistry.list());
  }

  public createSkillDraftFromExperience(experienceId: string) {
    const experience = this.dependencies.experiencePlane.show(experienceId);
    if (experience === null) {
      throw new Error(`Experience ${experienceId} was not found.`);
    }
    return this.dependencies.skillDraftManager.createDraftFromExperience(experience);
  }

  public promoteSkillDraft(draftId: string) {
    return this.dependencies.skillDraftManager.promoteDraft(draftId);
  }

  public rollbackSkillPromotion(skillId: string, reason: string) {
    return this.dependencies.skillDraftManager.rollbackPromotion(skillId, reason);
  }

  public listSkillVersions(skillId: string) {
    return this.dependencies.skillDraftManager.listVersions(skillId);
  }

  public showMemoryScope(scope: MemoryScope, scopeKey: string): {
    memories: MemoryRecord[];
    snapshots: MemorySnapshotRecord[];
  } {
    if (scope === "working") {
      const checkpoint = this.dependencies.findExecutionCheckpoint(scopeKey);
      return {
        memories:
          checkpoint?.memoryContext.map((fragment) =>
            contextFragmentToMemoryRecord(fragment, scopeKey, checkpoint.updatedAt)
          ) ?? [],
        snapshots: []
      };
    }
    return this.dependencies.memoryPlane.showScope(scope, scopeKey);
  }

  public createMemorySnapshot(
    scope: MemoryScope,
    scopeKey: string,
    label: string,
    createdBy: string
  ): MemorySnapshotRecord {
    return this.dependencies.memoryPlane.createSnapshot({
      createdBy,
      label,
      scope,
      scopeKey
    });
  }

  public reviewMemory(
    memoryId: string,
    status: "verified" | "rejected" | "stale",
    reviewerId: string,
    note: string
  ): MemoryRecord {
    return this.dependencies.memoryPlane.reviewMemory({
      memoryId,
      note,
      reviewerId,
      status
    });
  }

  public addMemory(input: {
    content: string;
    cwd: string;
    profileId: string;
    reviewerId: string;
    scope: "profile" | "project";
    userId: string;
  }): MemoryRecord {
    const content = input.content.trim();
    if (content.length === 0) {
      throw new Error("Memory content must not be empty.");
    }

    const scopeKey =
      input.scope === "project" ? input.cwd : `${input.userId}:${input.profileId}`;
    const summary = summarizeText(content, 160);
    const title = summarizeText(content, 80);
    const keywords = extractMemoryKeywords(content);
    const memory = this.dependencies.memoryPlane.writeMemory({
      confidence: 0.95,
      content,
      expiresAt: null,
      keywords,
      metadata: {
        createdBy: input.reviewerId,
        creationSurface: "manual_add"
      },
      privacyLevel: "internal",
      retentionPolicy: {
        kind: input.scope,
        reason: `Manual memory added by ${input.reviewerId}.`,
        ttlDays: 90
      },
      scope: input.scope,
      scopeKey,
      source: {
        label: `Manual memory added by ${input.reviewerId}`,
        sourceType: "manual_review",
        taskId: null,
        toolCallId: null,
        traceEventId: null
      },
      status: "verified",
      summary,
      title
    });

    if (memory === null) {
      throw new Error("Memory write was rejected by policy.");
    }

    return memory;
  }

  public forgetMemory(memoryId: string, reviewerId: string, note: string): MemoryRecord {
    return this.reviewMemory(memoryId, "stale", reviewerId, note);
  }

  public explainMemoryRecall(taskId: string, memoryId?: string): {
    entries: Array<{
      blocked: boolean;
      confidence: number;
      downrankReasons: string[];
      explanation: string;
      filterReason: string | null;
      filterReasonCode: string | null;
      memoryId: string;
      selected: boolean;
      status: string;
      title: string;
    }>;
    query: string;
    selectedMemoryIds: string[];
    taskId: string;
  } | null {
    const payload = this.traceTaskContext(taskId).memoryRecall;
    if (payload === null) {
      return null;
    }

    const entries =
      memoryId === undefined
        ? payload.entries
        : payload.entries.filter((entry) => entry.memoryId === memoryId);
    return {
      entries: entries.map((entry) => ({
        blocked: entry.blocked,
        confidence: entry.confidence,
        downrankReasons: entry.downrankReasons,
        explanation: entry.explanation,
        filterReason: entry.filterReason,
        filterReasonCode: entry.filterReasonCode,
        memoryId: entry.memoryId,
        selected: entry.selected,
        status: entry.status,
        title: entry.title
      })),
      query: payload.query,
      selectedMemoryIds: payload.selectedMemoryIds,
      taskId
    };
  }

  public listMemorySuggestions(query: {
    limit?: number;
    status?: InboxItem["status"];
    userId?: string;
  } = {}): InboxItem[] {
    return this.dependencies.listInboxItems({
      category: "memory_suggestion",
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.userId !== undefined ? { userId: query.userId } : {})
    });
  }

  public acceptMemorySuggestion(inboxId: string, reviewerId: string): {
    inboxItem: InboxItem;
    memory: MemoryRecord | null;
  } {
    const item = this.requireMemorySuggestion(inboxId);
    const draft = parseMemorySuggestionDraft(item.metadata);
    const memory =
      draft === null
        ? this.restoreExistingSuggestedMemory(item)
        : this.dependencies.memoryPlane.writeMemory({
            confidence: draft.confidence,
            content: draft.content,
            expiresAt: null,
            keywords: draft.keywords,
            metadata: {
              ...draft.metadata,
              acceptedFromInboxId: item.inboxId,
              acceptedBy: reviewerId
            },
            privacyLevel: draft.privacyLevel,
            retentionPolicy: draft.retentionPolicy,
            scope: draft.scope,
            scopeKey: draft.scopeKey,
            source: draft.source,
            status: "verified",
            summary: draft.summary,
            title: draft.title
          });
    const done = this.dependencies.inboxService.markDone(inboxId, reviewerId);
    return { inboxItem: done, memory };
  }

  public dismissMemorySuggestion(inboxId: string): InboxItem {
    this.requireMemorySuggestion(inboxId);
    return this.dependencies.inboxService.markDismissed(inboxId);
  }

  public listPendingApprovals(): ApprovalRecord[] {
    this.reconcileExpiredApprovals();
    return this.dependencies.listPendingApprovals();
  }

  public listPendingClarifyPrompts(): ClarifyPromptRecord[] {
    this.reconcileExpiredApprovals();
    return this.dependencies.listPendingClarifyPrompts();
  }

  public async resolveApproval(
    approvalId: string,
    action: "allow" | "deny",
    reviewerId: string,
    allowScope?: ApprovalAllowScope
  ): Promise<ApprovalActionResult> {
    this.reconcileExpiredApprovals();
    const parsed = approvalActionSchema.parse({
      action,
      allowScope,
      approvalId,
      reviewerId
    });
    const existingApproval = this.dependencies.approvalService.findById(parsed.approvalId);
    if (existingApproval !== null && existingApproval.status !== "pending") {
      if (existingApproval.status === "denied" || existingApproval.status === "timed_out") {
        return this.resumeApprovalFailureOnce(existingApproval);
      }
      return this.toCompletedApprovalActionResult(existingApproval);
    }

    const approval = this.dependencies.approvalService.resolve({
      action: parsed.action,
      approvalId: parsed.approvalId,
      reviewerId: parsed.reviewerId,
      ...(parsed.allowScope !== undefined ? { allowScope: parsed.allowScope } : {})
    });
    if (approval.status === "approved" && approval.allowScope === "always") {
      this.dependencies.approvalRuleStore.addAlwaysRulesFromApproval(approval, reviewerId);
    }

    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "approval_resolved",
      payload: {
        approvalId: approval.approvalId,
        reviewerId: approval.reviewerId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName
      },
      stage: "governance",
      summary: `Approval ${approval.status} for ${approval.toolName}`,
      taskId: approval.taskId
    });
    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "review_resolved",
      payload: {
        approvalId: approval.approvalId,
        reviewerId: approval.reviewerId,
        status: approval.status,
        toolCallId: approval.toolCallId,
        toolName: approval.toolName
      },
      stage: "lifecycle",
      summary: `Review resolved for ${approval.toolName}`,
      taskId: approval.taskId
    });

    this.dependencies.auditService.record({
      action: "approval_resolved",
      actor: `reviewer.${reviewerId}`,
      approvalId: approval.approvalId,
      outcome:
        approval.status === "approved"
          ? "approved"
          : approval.status === "timed_out"
            ? "timed_out"
            : "denied",
      payload: {
        allowScope: approval.allowScope,
        reviewerId,
        status: approval.status,
        toolName: approval.toolName
      },
      summary: `Approval ${approval.status} for ${approval.toolName}`,
      taskId: approval.taskId,
      toolCallId: approval.toolCallId
    });

    if (approval.status === "approved") {
      try {
        const result = await this.dependencies.executionKernel.resumeTask(approval.taskId);
        this.projectAssistantOutput(result.task.sessionId ?? null, result.task.taskId, result.output ?? null);
        return {
          approval,
          output: result.output,
          task: result.task
        };
      } catch (error) {
        const appError = toAppError(error);
        const task = this.dependencies.findTask(approval.taskId);
        if (task === null) {
          throw appError;
        }

        return {
          approval,
          error: appError,
          output: null,
          task
        };
      }
    }

    return this.resumeApprovalFailureOnce(approval);
  }

  private resumeApprovalFailureOnce(approval: ApprovalRecord): Promise<ApprovalActionResult> {
    const existing = this.approvalFailureContinuations.get(approval.approvalId);
    if (existing !== undefined) {
      return existing;
    }

    const continuation = this.resumeApprovalFailure(approval).finally(() => {
      this.approvalFailureContinuations.delete(approval.approvalId);
    });
    this.approvalFailureContinuations.set(approval.approvalId, continuation);
    return continuation;
  }

  private async resumeApprovalFailure(approval: ApprovalRecord): Promise<ApprovalActionResult> {
    const task = this.dependencies.findTask(approval.taskId);
    if (task === null || task.status !== "waiting_approval") {
      return this.toCompletedApprovalActionResult(approval);
    }

    try {
      const result = await this.dependencies.executionKernel.resumeTaskAfterApprovalFailure(
        approval.taskId,
        approval.toolCallId
      );
      this.projectAssistantOutput(result.task.sessionId ?? null, result.task.taskId, result.output ?? null);
      return {
        approval,
        output: result.output,
        task: result.task
      };
    } catch (error) {
      const appError = toAppError(error);
      const currentTask = this.dependencies.findTask(approval.taskId);
      if (currentTask === null) {
        throw appError;
      }

      return {
        approval,
        error: appError,
        output: null,
        task: currentTask
      };
    }
  }

  private toCompletedApprovalActionResult(approval: ApprovalRecord): ApprovalActionResult {
    const task = this.dependencies.findTask(approval.taskId);
    if (task === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Task ${approval.taskId} was not found.`
      });
    }
    const result: ApprovalActionResult = {
      approval,
      output: task.finalOutput,
      task
    };
    if (task.errorCode !== null) {
      result.error = new AppError({
        code: task.errorCode,
        message: task.errorMessage ?? task.errorCode
      });
    }
    return result;
  }

  public async answerClarifyPrompt(
    promptId: string,
    reviewerId: string,
    input: {
      answerOptionId?: string;
      answerText?: string;
      answers?: Record<string, string | string[]>;
      response?: string;
    }
  ): Promise<ClarifyActionResult> {
    this.reconcileExpiredApprovals();
    const parsed = clarifyAnswerSchema.parse({
      ...input,
      promptId,
      reviewerId
    });
    const prompt = this.dependencies.clarifyService.answer({
        promptId: parsed.promptId,
        reviewerId: parsed.reviewerId,
        ...(parsed.answerOptionId !== undefined ? { answerOptionId: parsed.answerOptionId } : {}),
        ...(parsed.answerText !== undefined ? { answerText: parsed.answerText } : {}),
        ...(parsed.answers !== undefined ? { answers: parsed.answers } : {}),
        ...(parsed.response !== undefined ? { response: parsed.response } : {})
      });
    const checkpoint = this.dependencies.findExecutionCheckpoint(prompt.taskId);
    if (checkpoint === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${prompt.taskId} has no checkpoint for clarification.`
      });
    }

    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "clarify_resolved",
      payload: {
          answerOptionId: prompt.answerOptionId,
          answers: prompt.answers,
          answerText: prompt.answerText,
          promptId: prompt.promptId,
          response: prompt.response,
          status: "answered"
      },
      stage: "governance",
      summary: `Clarification answered for task ${prompt.taskId}`,
      taskId: prompt.taskId
    });

    const answerText = formatClarifyAnswerForModel(prompt);
    const updatedCheckpoint = {
      ...checkpoint,
      messages: [
        ...checkpoint.messages,
        {
          role: "user" as const,
          content: answerText,
          metadata: {
            clarifyPromptId: prompt.promptId,
            clarifyAnswerOptionId: prompt.answerOptionId
          }
        }
      ],
      pendingClarifyPromptId: null,
      updatedAt: new Date().toISOString()
    };
    this.dependencies.saveExecutionCheckpoint(updatedCheckpoint);

    try {
      const result = await this.dependencies.executionKernel.resumeTask(prompt.taskId);
      this.projectAssistantOutput(result.task.sessionId ?? null, result.task.taskId, result.output ?? null);
      return {
        output: result.output,
        prompt,
        task: result.task
      };
    } catch (error) {
      const appError = toAppError(error);
      const task = this.dependencies.findTask(prompt.taskId);
      if (task === null) {
        throw appError;
      }
      return {
        error: appError,
        output: null,
        prompt,
        task
      };
    }
  }

  public cancelClarifyPrompt(promptId: string, reviewerId: string): ClarifyActionResult {
    this.reconcileExpiredApprovals();
    const prompt = this.dependencies.clarifyService.cancel({ promptId, reviewerId });
    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "clarify_cancelled",
      payload: {
        promptId: prompt.promptId,
        reviewerId
      },
      stage: "governance",
      summary: `Clarification cancelled for task ${prompt.taskId}`,
      taskId: prompt.taskId
    });

    const failedTask = this.dependencies.executionKernel.failWaitingClarificationTask(
      prompt.taskId,
      new AppError({
        code: "clarification_cancelled",
        message: `Clarification prompt ${prompt.promptId} was cancelled.`
      })
    );

    return {
      output: null,
      prompt,
      task: failedTask
    };
  }

  public showTask(taskId: string): {
    approvals: ApprovalRecord[];
    artifacts: ArtifactRecord[];
    inboxItems: InboxItem[];
    scheduleRuns: ScheduleRunRecord[];
    task: TaskRecord | null;
    toolCalls: ToolCallRecord[];
    output: RuntimeOutputEvent[];
    trace: TraceEvent[];
  } {
    const task = this.dependencies.findTask(taskId);

    return {
      approvals: task === null ? [] : this.dependencies.listApprovals(taskId),
      artifacts: task === null ? [] : this.dependencies.listArtifacts(taskId),
      inboxItems: task === null ? [] : this.dependencies.listInboxItems({ taskId }),
      scheduleRuns: task === null ? [] : this.dependencies.listScheduleRunsByTask(taskId),
      task,
      toolCalls: task === null ? [] : this.dependencies.listToolCalls(taskId),
      output: task === null ? [] : this.dependencies.listOutputEvents(taskId),
      trace: task === null ? [] : this.dependencies.listTrace(taskId)
    };
  }

  public listInbox(query: InboxListQuery = {}): InboxItem[] {
    return this.dependencies.listInboxItems(query);
  }

  public showInboxItem(inboxId: string): InboxItem | null {
    return this.dependencies.findInboxItem(inboxId);
  }

  public markInboxDone(inboxId: string, reviewerUserId: string): InboxItem {
    return this.dependencies.inboxService.markDone(inboxId, reviewerUserId);
  }

  public markInboxDismissed(inboxId: string): InboxItem {
    return this.dependencies.inboxService.markDismissed(inboxId);
  }

  public subscribeInbox(
    filter: InboxListQuery,
    listener: (event: InboxDeliveryEvent) => void
  ): () => void {
    return this.dependencies.inboxService.subscribe(filter, listener);
  }

  public startScheduler(): void {
    this.dependencies.schedulerService.start();
  }

  public stopScheduler(): void {
    this.dependencies.schedulerService.stop();
  }

  public createSchedule(input: CreateScheduleInput): ScheduleRecord {
    return this.dependencies.schedulerService.createSchedule(input);
  }

  public updateSchedule(scheduleId: string, input: UpdateScheduleInput): ScheduleRecord {
    return this.dependencies.schedulerService.updateSchedule(scheduleId, input);
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.dependencies.schedulerService.listSchedules(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.dependencies.schedulerService.showSchedule(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.dependencies.schedulerService.listScheduleRuns(scheduleId, query);
  }

  public scheduleStatus(): ReturnType<SchedulerService["status"]> {
    return this.dependencies.schedulerService.status();
  }

  public async tickScheduleOnce(): Promise<void> {
    await this.dependencies.schedulerService.tickOnce();
  }

  public archiveSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.archiveSchedule(scheduleId);
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.pauseSchedule(scheduleId);
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    return this.dependencies.schedulerService.resumeSchedule(scheduleId);
  }

  public runScheduleNow(scheduleId: string): ScheduleRunRecord {
    return this.dependencies.schedulerService.runNow(scheduleId);
  }

  public listArtifacts(taskId: string): ArtifactRecord[] {
    return this.dependencies.listArtifacts(taskId);
  }

  public listProviders(): ProviderCatalogEntry[] {
    return this.dependencies.providerCatalog;
  }

  public currentProvider(): ResolvedProviderConfig {
    return this.dependencies.providerConfig;
  }

  public listConfiguredProviders(): ConfiguredProviderEntry[] {
    return listConfiguredProviders(this.dependencies.workspaceRoot);
  }

  public modelSelectionView(sessionId?: string): ModelSelectionView {
    const session = this.resolveOptionalSession(sessionId);
    return createModelSelectionView({
      currentProvider: this.dependencies.providerConfig,
      cwd: this.dependencies.workspaceRoot,
      runtimeConfig: resolveRuntimeConfig(this.dependencies.workspaceRoot),
      runtimeOverrideActive: this.dependencies.providerRouter?.hasMainProviderOverride() ?? false,
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
        tokenBudget: this.dependencies.tokenBudget,
        tokenBudgetInputLimitExplicit: this.dependencies.tokenBudgetInputLimitExplicit
      });
      this.applyProviderSwitchResult(result, { mainProviderOverride: false });
    } else {
      this.dependencies.providerRouter?.setMainProvider(null);
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

    const previousName = this.dependencies.providerConfig.name;
    const result = await switchProviderRuntime({
      cwd: this.dependencies.workspaceRoot,
      persist: input.persist,
      selection: input.selection,
      tokenBudget: this.dependencies.tokenBudget,
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
        mode: this.dependencies.providerRouter?.getMode() ?? "balanced",
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
    this.dependencies.provider = result.provider;
    this.dependencies.providerConfig = result.providerConfig;
    this.dependencies.tokenBudget = result.tokenBudget;
    this.dependencies.executionKernel.setPrimaryProvider(result.provider);
    this.dependencies.providerRouter?.setMainProvider(options.mainProviderOverride ? result.provider : null);
    this.dependencies.providerRouter?.clearProviderCache();
    this.dependencies.auxiliaryProviderResolver?.setMainProvider(result.provider);
    this.dependencies.auxiliaryProviderResolver?.clearProviderCache();
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
  public providerStats(groupBy: "provider" | "session" | "task" | "mode" = "provider"): ProviderStatsSnapshot | null | JsonObject {
    return new ProviderStatsService({
      listTasks: () => this.dependencies.listTasks(),
      listTrace: (taskId) => this.dependencies.listTrace(taskId),
      provider: this.dependencies.provider
    }).providerStats(groupBy);
  }

  public budgetReport(scope: "task" | "session", id: string): Record<string, unknown> {
    const state =
      scope === "task"
        ? this.dependencies.budgetService?.getTaskState(id)
        : this.dependencies.budgetService?.getSessionState(id);
    return {
      scope,
      id,
      state: state ?? null
    };
  }

  public setRoutingMode(mode: "cheap_first" | "balanced" | "quality_first"): void {
    this.dependencies.providerRouter?.setMode(mode);
    this.dependencies.auditService.record({
      action: "route_decided",
      actor: "runtime.application",
      approvalId: null,
      outcome: "succeeded",
      payload: { mode },
      summary: `Routing mode set to ${mode}`,
      taskId: null,
      toolCallId: null
    });
  }

  public traceTask(taskId: string): TraceEvent[] {
    return this.dependencies.listTrace(taskId);
  }

  public outputTask(taskId: string): RuntimeOutputEvent[] {
    return this.dependencies.listOutputEvents(taskId);
  }

  public outputSession(sessionId: string): RuntimeOutputEvent[] {
    return this.dependencies.listSessionOutputEvents(sessionId);
  }

  public subscribeToTaskOutput(
    taskId: string,
    listener: (event: RuntimeOutputEvent) => void
  ): () => void {
    return this.dependencies.outputService.subscribe((event) => {
      if (event.taskId === taskId) {
        listener(event);
      }
    });
  }

  public taskTimeline(taskId: string): TaskTimelineReport {
    const task = this.dependencies.findTask(taskId);
    const trace = task === null ? [] : this.dependencies.listTrace(taskId);

    return {
      entries: trace
        .filter((event) =>
          [
            "task_started",
            "repo_map_created",
            "provider_request_started",
            "provider_request_succeeded",
            "provider_request_failed",
            "tool_call_requested",
            "tool_call_finished",
            "tool_call_failed",
            "approval_requested",
            "approval_resolved",
            "retry",
            "loop_iteration_completed",
            "final_outcome"
          ].includes(event.eventType)
        )
        .map((event) => ({
          actor: event.actor,
          detail: event.summary,
          eventType: event.eventType,
          iteration: extractTimelineIteration(event),
          sequence: event.sequence,
          stage: event.stage,
          timestamp: event.timestamp
        })),
      task
    };
  }

  public subscribeToTaskTrace(taskId: string, listener: (event: TraceEvent) => void): () => void {
    return this.dependencies.traceService.subscribe((event) => {
      if (event.taskId === taskId) {
        listener(event);
      }
    });
  }

  private projectAssistantOutput(
    sessionId: string | null,
    taskId: string,
    output: string | null
  ): void {
    if (sessionId === null || output === null || output.trim().length === 0) {
      return;
    }
    this.dependencies.assistantSessionProjectionService.project({
      output,
      taskId,
      sessionId
    });
  }

  private requireMemorySuggestion(inboxId: string): InboxItem {
    const item = this.dependencies.findInboxItem(inboxId);
    if (item === null) {
      throw new Error(`Inbox item ${inboxId} was not found.`);
    }
    if (item.category !== "memory_suggestion") {
      throw new Error(`Inbox item ${inboxId} is not a memory suggestion.`);
    }
    return item;
  }

  private restoreExistingSuggestedMemory(item: InboxItem): MemoryRecord | null {
    const promotedMemoryId = typeof item.metadata.promotedMemoryId === "string" ? item.metadata.promotedMemoryId : null;
    if (promotedMemoryId === null) {
      return null;
    }
    const existing = this.dependencies.findMemory(promotedMemoryId);
    if (existing === null) {
      throw new Error(`Suggested memory ${promotedMemoryId} was not found.`);
    }
    return existing;
  }

  public traceTaskContext(taskId: string): ContextTraceDebugReport {
    const task = this.dependencies.findTask(taskId);
    const trace = task === null ? [] : this.dependencies.listTrace(taskId);
    const contextAssembly = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "context_assembled" }> =>
          event.eventType === "context_assembled"
      )?.payload.debugView ?? null;
    const memoryRecall = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "memory_recalled" }> =>
          event.eventType === "memory_recalled"
      )?.payload ?? null;
    const reviewerTrace = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "reviewer_trace" }> =>
          event.eventType === "reviewer_trace"
      )?.payload ?? null;
    const latestSessionSummary = [...trace]
      .reverse()
      .find(
        (event): event is Extract<TraceEvent, { eventType: "session_summary_written" }> =>
          event.eventType === "session_summary_written"
      )?.payload ?? null;

    return {
      contextAssembly,
      latestSessionSummary,
      memoryRecall,
      reviewerTrace,
      task
    };
  }

  public auditTask(taskId: string): AuditLogRecord[] {
    return this.dependencies.listAuditLogs(taskId);
  }

  public async rollbackFileArtifact(
    artifactId: string
  ): Promise<RollbackFileArtifactResult> {
    return new FileRollbackService({
      auditService: this.dependencies.auditService,
      findArtifact: (id) => this.dependencies.findArtifact(id),
      findLatestArtifactByType: (artifactType) =>
        this.dependencies.findLatestArtifactByType(artifactType),
      traceService: this.dependencies.traceService
    }).rollbackFileArtifact(artifactId);
  }

  public async testCurrentProvider(signal?: AbortSignal): Promise<ProviderHealthCheck> {
    if (this.dependencies.provider.testConnection === undefined) {
      return {
        apiKeyConfigured: this.dependencies.providerConfig.apiKey !== null,
        endpointReachable: null,
        message: "Current provider does not expose a connection test.",
        modelAvailable: null,
        modelConfigured: this.dependencies.providerConfig.model !== null,
        modelName: this.dependencies.providerConfig.model,
        ok: false,
        providerName: this.dependencies.provider.name
      };
    }

    return this.dependencies.provider.testConnection(signal);
  }

  public async configDoctor(signal?: AbortSignal): Promise<AgentDoctorReport> {
    return new RuntimeDoctorService({
      allowedFetchHosts: this.dependencies.allowedFetchHosts,
      databasePath: this.dependencies.databasePath,
      listExperiences: () => this.dependencies.listExperiences(),
      providerConfig: this.dependencies.providerConfig,
      providerName: this.dependencies.provider.name,
      runtimeConfigPath: this.dependencies.runtimeConfigPath,
      runtimeConfigSource: this.dependencies.runtimeConfigSource,
      runtimeVersion: this.dependencies.runtimeVersion,
      customShell: this.dependencies.customShell,
      maxShellTimeoutMs: this.dependencies.maxShellTimeoutMs,
      shellBackend: this.dependencies.shellBackend,
      skillStats: () => this.dependencies.skillRegistry.listSkills(),
      testCommands: this.dependencies.testCommands,
      testCurrentProvider: (providerSignal) => this.testCurrentProvider(providerSignal),
      tokenBudget: this.dependencies.tokenBudget,
      workspaceRoot: this.dependencies.workspaceRoot
    }).configDoctor(signal);
  }

  public async smokeCurrentProvider(signal?: AbortSignal): Promise<ProviderSmokeReport> {
    const startedAt = Date.now();
    const now = new Date().toISOString();
    const tokenBudget = {
      ...this.dependencies.tokenBudget,
      usedInput: 0,
      usedOutput: 0
    };
    const task: TaskRecord = {
      agentProfileId: "executor",
      createdAt: now,
      currentIteration: 2,
      cwd: this.dependencies.workspaceRoot,
      errorCode: null,
      errorMessage: null,
      finalOutput: null,
      finishedAt: null,
      input: "Provider smoke post-tool turn.",
      maxIterations: 2,
      metadata: { diagnostic: "provider_smoke" },
      providerName: this.dependencies.provider.name,
      requesterUserId: "provider-smoke",
      startedAt: now,
      status: "running",
      taskId: randomUUID(),
      tokenBudget,
      updatedAt: now
    };
    const controller = signal === undefined ? new AbortController() : null;

    try {
      await this.dependencies.provider.generate({
        agentProfileId: "executor",
        availableTools: [
          {
            capability: "filesystem.read",
            description: "Read a small workspace file.",
            inputSchema: {
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object"
            },
            name: "read_file",
            privacyLevel: "internal",
            riskLevel: "low"
          }
        ],
        iteration: 2,
        memoryContext: [],
        messages: [
          {
            content: "Answer with a short acknowledgement after the tool result.",
            role: "system"
          },
          {
            content: "Read the project plan.",
            role: "user"
          },
          {
            content: "",
            role: "assistant",
            toolCalls: [
              {
                input: { path: "PLAN.md" },
                reason: "Provider smoke synthetic tool request.",
                toolCallId: "provider-smoke-file-read",
                toolName: "read_file"
              }
            ]
          },
          {
            content: '{"ok":true,"summary":"Synthetic provider smoke tool result."}',
            role: "tool",
            toolCallId: "provider-smoke-file-read",
            toolName: "read_file"
          }
        ],
        signal: signal ?? controller!.signal,
        task,
        tokenBudget
      });
      return {
        errorCategory: null,
        latencyMs: Date.now() - startedAt,
        message: "Synthetic post-tool turn completed.",
        modelName: this.dependencies.providerConfig.model,
        ok: true,
        providerName: this.dependencies.provider.name,
        streamIdleTimeoutMs: this.dependencies.providerConfig.streamIdleTimeoutMs,
        timeoutMs: this.dependencies.providerConfig.timeoutMs
      };
    } catch (error) {
      const providerError = error as { category?: string; message?: string };
      return {
        errorCategory: providerError.category ?? "unknown_error",
        latencyMs: Date.now() - startedAt,
        message: providerError.message ?? "Provider smoke failed.",
        modelName: this.dependencies.providerConfig.model,
        ok: false,
        providerName: this.dependencies.provider.name,
        streamIdleTimeoutMs: this.dependencies.providerConfig.streamIdleTimeoutMs,
        timeoutMs: this.dependencies.providerConfig.timeoutMs
      };
    }
  }

  private reconcileExpiredApprovals(): void {
    for (const approval of this.dependencies.approvalService.expirePending()) {
      this.dependencies.traceService.record({
        actor: "approval.service",
        eventType: "approval_resolved",
        payload: {
          approvalId: approval.approvalId,
          reviewerId: approval.reviewerId,
          status: approval.status,
          toolCallId: approval.toolCallId,
          toolName: approval.toolName
        },
        stage: "governance",
        summary: `Approval ${approval.status} for ${approval.toolName}`,
        taskId: approval.taskId
      });

      this.dependencies.auditService.record({
        action: "approval_resolved",
        actor: "approval.service",
        approvalId: approval.approvalId,
        outcome: "timed_out",
        payload: {
          status: approval.status,
          toolName: approval.toolName
        },
        summary: `Approval ${approval.status} for ${approval.toolName}`,
        taskId: approval.taskId,
        toolCallId: approval.toolCallId
      });

      void this.resumeApprovalFailureOnce(approval);
    }

    for (const prompt of this.dependencies.clarifyService.expirePending()) {
      this.dependencies.traceService.record({
        actor: "clarify.service",
        eventType: "clarify_resolved",
        payload: {
          promptId: prompt.promptId,
          status: "timed_out"
        },
        stage: "governance",
        summary: `Clarification timed out for task ${prompt.taskId}`,
        taskId: prompt.taskId
      });

      this.dependencies.updateToolCall(prompt.toolCallId, {
        errorCode: "approval_timeout",
        errorMessage: `Clarification prompt ${prompt.promptId} timed out.`,
        finishedAt: new Date().toISOString(),
        status: "timed_out"
      });

      this.dependencies.executionKernel.failWaitingClarificationTask(
        prompt.taskId,
        new AppError({
          code: "approval_timeout",
          message: `Clarification prompt ${prompt.promptId} timed out.`
        })
      );
    }
  }
}

interface MemorySuggestionDraftShape {
  confidence: number;
  content: string;
  keywords: string[];
  metadata: JsonObject;
  privacyLevel: "public" | "internal" | "restricted";
  retentionPolicy: MemoryRecord["retentionPolicy"];
  scope: "profile" | "project";
  scopeKey: string;
  source: MemoryRecord["source"];
  summary: string;
  title: string;
}

function extractTimelineIteration(event: TraceEvent): number | null {
  const payload = event.payload as { iteration?: unknown };
  return typeof payload.iteration === "number" ? payload.iteration : null;
}

function summarizeText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
}

function extractMemoryKeywords(content: string): string[] {
  const matches = content.toLowerCase().match(/[a-z0-9_./:-]{3,}/gu) ?? [];
  return [...new Set(matches)].slice(0, 16);
}

function formatClarifyAnswerForModel(prompt: ClarifyPromptRecord): string {
  if (prompt.response !== null) {
    return prompt.response;
  }
  const answers = prompt.answers ?? deriveLegacyClarifyAnswers(prompt);
  if (answers !== null) {
    return Object.entries(answers)
      .map(([question, answer]) => {
        const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
        return `${question}\nAnswer: ${answerText}`;
      })
      .join("\n\n");
  }
  return (
    prompt.answerText ??
    prompt.options.find((item) => item.id === prompt.answerOptionId)?.label ??
    ""
  );
}

function deriveLegacyClarifyAnswers(prompt: ClarifyPromptRecord): Record<string, string | string[]> | null {
  if (prompt.answerText !== null) {
    return { [prompt.question]: prompt.answerText };
  }
  if (prompt.answerOptionId !== null) {
    const option = prompt.options.find((item) => item.id === prompt.answerOptionId);
    if (option !== undefined) {
      return { [prompt.question]: option.label };
    }
  }
  return null;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMemorySuggestionDraft(metadata: JsonObject): MemorySuggestionDraftShape | null {
  const raw = metadata.memorySuggestionDraft;
  if (!isJsonObject(raw)) {
    return null;
  }
  if (
    typeof raw.content !== "string" ||
    typeof raw.scope !== "string" ||
    typeof raw.scopeKey !== "string" ||
    typeof raw.title !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.confidence !== "number" ||
    !Array.isArray(raw.keywords) ||
    typeof raw.privacyLevel !== "string" ||
    !isJsonObject(raw.source) ||
    !isJsonObject(raw.retentionPolicy)
  ) {
    return null;
  }
  return {
    confidence: raw.confidence,
    content: raw.content,
    keywords: raw.keywords.filter((entry): entry is string => typeof entry === "string"),
    metadata: isJsonObject(raw.metadata) ? raw.metadata : {},
    privacyLevel:
      raw.privacyLevel === "public" || raw.privacyLevel === "restricted"
        ? raw.privacyLevel
        : "internal",
    retentionPolicy: {
      kind:
        raw.retentionPolicy.kind === "profile" || raw.retentionPolicy.kind === "project"
          ? raw.retentionPolicy.kind
          : "project",
      reason:
        typeof raw.retentionPolicy.reason === "string"
          ? raw.retentionPolicy.reason
          : "Accepted from memory suggestion inbox item.",
      ttlDays:
        typeof raw.retentionPolicy.ttlDays === "number" || raw.retentionPolicy.ttlDays === null
          ? raw.retentionPolicy.ttlDays
          : 90
    },
    scope: raw.scope === "profile" ? "profile" : "project",
    scopeKey: raw.scopeKey,
    source: {
      label: typeof raw.source.label === "string" ? raw.source.label : "Memory suggestion inbox draft",
      sourceType:
        raw.source.sourceType === "manual_review" ||
        raw.source.sourceType === "tool_output" ||
        raw.source.sourceType === "system" ||
        raw.source.sourceType === "user_input" ||
        raw.source.sourceType === "final_output" ||
        raw.source.sourceType === "session_compact"
          ? raw.source.sourceType
          : "manual_review",
      taskId: typeof raw.source.taskId === "string" || raw.source.taskId === null ? raw.source.taskId : null,
      toolCallId:
        typeof raw.source.toolCallId === "string" || raw.source.toolCallId === null
          ? raw.source.toolCallId
          : null,
      traceEventId:
        typeof raw.source.traceEventId === "string" || raw.source.traceEventId === null
          ? raw.source.traceEventId
          : null
    },
    summary: raw.summary,
    title: raw.title
  };
}

function contextFragmentToMemoryRecord(
  fragment: ContextFragment,
  scopeKey: string,
  timestamp: string
): MemoryRecord {
  return {
    confidence: fragment.confidence,
    conflictsWith: [],
    content: fragment.text,
    createdAt: timestamp,
    expiresAt: null,
    keywords: [],
    lastVerifiedAt: null,
    memoryId: fragment.memoryId,
    metadata: {
      explanation: fragment.explanation,
      runtimeOnly: true
    },
    privacyLevel: fragment.privacyLevel,
    retentionPolicy: fragment.retentionPolicy,
    scope: "working",
    scopeKey,
    source: {
      label: "runtime checkpoint fragment",
      sourceType: fragment.sourceType,
      taskId: scopeKey,
      toolCallId: null,
      traceEventId: null
    },
    sourceType: fragment.sourceType,
    status: fragment.status,
    summary: fragment.text,
    supersedes: null,
    title: fragment.title,
    updatedAt: timestamp
  };
}


