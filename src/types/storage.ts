import type {
  SessionMessageDraft,
  SessionMessageRecord,
  SessionMessageSearchHit
} from "./session-message.js";
import type { GatewaySessionBinding } from "./adapter.js";
import type { GatewaySessionBindingDraft } from "./gateway.js";
import type {
  SessionDraft,
  SessionLineageDraft,
  SessionLineageRecord,
  SessionRecord,
  SessionTaskDraft,
  SessionTaskRecord,
  SessionStatus,
  SessionUpdatePatch
} from "./session.js";
import type {
  SessionSearchHit,
  SessionSummaryDraft,
  SessionSummaryRecord
} from "./session-summary.js";
import type { ApprovalDraft, ApprovalRecord, ApprovalUpdatePatch } from "./approval.js";
import type { ClarifyPromptDraft, ClarifyPromptRecord, ClarifyPromptUpdatePatch } from "./clarify.js";
import type { AuditLogDraft, AuditLogRecord } from "./audit.js";
import type { ExecutionCheckpointRecord } from "./checkpoint.js";
import type {
  ExperienceDraft,
  ExperienceQuery,
  ExperienceRecord,
  ExperienceUpdatePatch
} from "./experience.js";
import type {
  MemoryDraft,
  MemoryEmbeddingRecord,
  MemoryQuery,
  MemoryRecord,
  MemorySnapshotDraft,
  MemorySnapshotRecord,
  SessionCoreSnapshotDraft,
  SessionCoreSnapshotRecord,
  MemoryUpdatePatch
} from "./memory.js";
import type { ArtifactDraft, ArtifactRecord, ToolCallRecord } from "./tool.js";
import type { TraceEvent } from "./trace.js";
import type { RuntimeOutputEvent } from "./output.js";
import type { RunMetadataRecord, TaskDraft, TaskRecord, TaskStatus } from "./task.js";
import type { SessionTranscriptEventDraft, SessionTranscriptEventRecord } from "./session-transcript.js";
import type { RuntimeErrorCode } from "./error.js";
import type {
  ScheduleDraft,
  ScheduleDueQuery,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunDraft,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleRunUpdatePatch,
  ScheduleUpdatePatch
} from "./schedule.js";
import type {
  InboxDedupQuery,
  InboxItem,
  InboxItemDraft,
  InboxItemUpdatePatch,
  InboxListQuery
} from "./inbox.js";
import type {
  CommitmentDraft,
  CommitmentListQuery,
  CommitmentRecord,
  CommitmentUpdatePatch,
  NextActionDraft,
  NextActionListQuery,
  NextActionRecord,
  NextActionUpdatePatch
} from "./commitment.js";
import type { TokenBudget, JsonObject } from "./common.js";

export interface TaskUpdatePatch {
  status?: TaskStatus;
  currentIteration?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
  finalOutput?: string | null;
  errorCode?: RuntimeErrorCode | null;
  errorMessage?: string | null;
  tokenBudget?: TokenBudget;
  metadata?: JsonObject;
}

export interface TaskRepository {
  create(task: TaskDraft): TaskRecord;
  findById(taskId: string): TaskRecord | null;
  list(): TaskRecord[];
  update(taskId: string, patch: TaskUpdatePatch): TaskRecord;
}

export interface SessionListQuery {
  ownerUserId?: string;
  status?: SessionStatus;
}

export interface SessionRepository {
  create(session: SessionDraft): SessionRecord;
  getOrCreate(session: SessionDraft): SessionRecord;
  findById(sessionId: string): SessionRecord | null;
  list(query?: SessionListQuery): SessionRecord[];
  update(sessionId: string, patch: SessionUpdatePatch): SessionRecord;
  findLatestByOwner(ownerUserId: string): SessionRecord | null;
}

export interface SessionTaskRepository {
  create(record: SessionTaskDraft): SessionTaskRecord;
  findByTaskId(taskId: string): SessionTaskRecord | null;
  listBySessionId(sessionId: string): SessionTaskRecord[];
  findLatestBySessionId(sessionId: string): SessionTaskRecord | null;
}

export interface SessionLineageRepository {
  append(record: SessionLineageDraft): SessionLineageRecord;
  listBySessionId(sessionId: string): SessionLineageRecord[];
}

export interface SessionSummaryRepository {
  create(record: SessionSummaryDraft): SessionSummaryRecord;
  findById(sessionSummaryId: string): SessionSummaryRecord | null;
  findLatestBySession(sessionId: string): SessionSummaryRecord | null;
  listBySession(sessionId: string): SessionSummaryRecord[];
  search(input: { limit: number; query: string; sessionId: string }): SessionSearchHit[];
  searchGlobal(input: {
    limit: number;
    query: string;
    excludeSessionId?: string | null;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionSearchHit[];
}

export interface SessionTranscriptRepository {
  append(record: SessionTranscriptEventDraft): SessionTranscriptEventRecord;
  listBySessionId(sessionId: string): SessionTranscriptEventRecord[];
  listByTaskId(taskId: string): SessionTranscriptEventRecord[];
}

export interface ScheduleRepository {
  create(record: ScheduleDraft): ScheduleRecord;
  findById(scheduleId: string): ScheduleRecord | null;
  list(query?: ScheduleListQuery): ScheduleRecord[];
  update(scheduleId: string, patch: ScheduleUpdatePatch): ScheduleRecord;
  findDue(query: ScheduleDueQuery): ScheduleRecord[];
}

export interface ScheduleRunRepository {
  create(record: ScheduleRunDraft): ScheduleRunRecord;
  findById(runId: string): ScheduleRunRecord | null;
  list(query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listByScheduleId(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listByTaskId(taskId: string): ScheduleRunRecord[];
  listBySessionId(sessionId: string): ScheduleRunRecord[];
  findActiveByScheduleId(scheduleId: string): ScheduleRunRecord | null;
  claimDue(now: string, limit: number): ScheduleRunRecord[];
  update(runId: string, patch: ScheduleRunUpdatePatch): ScheduleRunRecord;
}

export interface InboxRepository {
  create(record: InboxItemDraft): InboxItem;
  findById(inboxId: string): InboxItem | null;
  findByDedup(query: InboxDedupQuery): InboxItem | null;
  list(query?: InboxListQuery): InboxItem[];
  update(inboxId: string, patch: InboxItemUpdatePatch): InboxItem;
}

export interface CommitmentRepository {
  create(record: CommitmentDraft): CommitmentRecord;
  findById(commitmentId: string): CommitmentRecord | null;
  list(query?: CommitmentListQuery): CommitmentRecord[];
  update(commitmentId: string, patch: CommitmentUpdatePatch): CommitmentRecord;
}

export interface NextActionRepository {
  create(record: NextActionDraft): NextActionRecord;
  findById(nextActionId: string): NextActionRecord | null;
  list(query?: NextActionListQuery): NextActionRecord[];
  update(nextActionId: string, patch: NextActionUpdatePatch): NextActionRecord;
}

export interface TraceRepository {
  append(event: Omit<TraceEvent, "sequence">): TraceEvent;
  listByTaskId(taskId: string): TraceEvent[];
}

export interface RuntimeOutputRepository {
  append(event: Omit<RuntimeOutputEvent, "sequence">): RuntimeOutputEvent;
  listByTaskId(taskId: string): RuntimeOutputEvent[];
  listBySessionId(sessionId: string): RuntimeOutputEvent[];
}

export interface ToolCallRepository {
  create(record: ToolCallRecord): ToolCallRecord;
  findById(toolCallId: string): ToolCallRecord | null;
  update(toolCallId: string, patch: Partial<ToolCallRecord>): ToolCallRecord;
  listByTaskId(taskId: string): ToolCallRecord[];
}

export interface ArtifactRepository {
  createMany(
    taskId: string,
    toolCallId: string | null,
    artifacts: ArtifactDraft[]
  ): ArtifactRecord[];
  findById(artifactId: string): ArtifactRecord | null;
  findLatestByType(artifactType: string): ArtifactRecord | null;
  listByTaskId(taskId: string): ArtifactRecord[];
}

export interface RunMetadataRepository {
  create(record: RunMetadataRecord): RunMetadataRecord;
  findByTaskId(taskId: string): RunMetadataRecord | null;
}

export interface ApprovalRepository {
  create(record: ApprovalDraft): ApprovalRecord;
  findById(approvalId: string): ApprovalRecord | null;
  findLatestByToolCall(taskId: string, toolCallId: string): ApprovalRecord | null;
  listByTaskId(taskId: string): ApprovalRecord[];
  listPending(): ApprovalRecord[];
  update(approvalId: string, patch: ApprovalUpdatePatch): ApprovalRecord;
}

export interface ClarifyPromptRepository {
  create(record: ClarifyPromptDraft): ClarifyPromptRecord;
  findById(promptId: string): ClarifyPromptRecord | null;
  findLatestByToolCall(taskId: string, toolCallId: string): ClarifyPromptRecord | null;
  listByTaskId(taskId: string): ClarifyPromptRecord[];
  listPending(): ClarifyPromptRecord[];
  update(promptId: string, patch: ClarifyPromptUpdatePatch): ClarifyPromptRecord;
}

export interface AuditLogRepository {
  append(record: AuditLogDraft): AuditLogRecord;
  listByTaskId(taskId: string): AuditLogRecord[];
}

export interface ExecutionCheckpointRepository {
  save(record: ExecutionCheckpointRecord): ExecutionCheckpointRecord;
  findByTaskId(taskId: string): ExecutionCheckpointRecord | null;
  delete(taskId: string): void;
}

export interface MemoryEmbeddingRepository {
  upsert(record: Omit<MemoryEmbeddingRecord, "updatedAt">): MemoryEmbeddingRecord;
  findByMemoryId(memoryId: string): MemoryEmbeddingRecord | null;
  remove(memoryId: string): void;
  count(): number;
}

export interface MemoryRepository {
  create(record: MemoryDraft): MemoryRecord;
  findById(memoryId: string): MemoryRecord | null;
  list(query?: MemoryQuery): MemoryRecord[];
  update(memoryId: string, patch: MemoryUpdatePatch): MemoryRecord;
}

export interface ExperienceRepository {
  create(record: ExperienceDraft): ExperienceRecord;
  findById(experienceId: string): ExperienceRecord | null;
  list(query?: ExperienceQuery): ExperienceRecord[];
  update(experienceId: string, patch: ExperienceUpdatePatch): ExperienceRecord;
}

export interface MemorySnapshotRepository {
  create(record: MemorySnapshotDraft): MemorySnapshotRecord;
  findById(snapshotId: string): MemorySnapshotRecord | null;
  listByScope(scope: MemorySnapshotRecord["scope"], scopeKey: string): MemorySnapshotRecord[];
}

export interface SessionCoreSnapshotRepository {
  create(record: SessionCoreSnapshotDraft): SessionCoreSnapshotRecord;
  findBySessionId(sessionId: string): SessionCoreSnapshotRecord | null;
  deleteBySessionId(sessionId: string): void;
}

export interface SessionMessageRepository {
  append(record: SessionMessageDraft): SessionMessageRecord;
  countBySessionId(sessionId: string): number;
  deleteBySessionId(sessionId: string): void;
  findLatestUserPreview(sessionId: string): string | null;
  listBySessionId(sessionId: string): SessionMessageRecord[];
  replaceAll(sessionId: string, messages: SessionMessageDraft[]): SessionMessageRecord[];
  search(input: {
    limit: number;
    query: string;
    sessionIdPrefix?: string;
    ownerUserId?: string;
    workspaceRoot?: string;
    roleFilter?: Array<"user" | "agent" | "system" | "activity" | "approval" | "approval_result" | "error">;
    window?: number;
  }): SessionMessageSearchHit[];
  scroll?(input: {
    sessionId: string;
    aroundMessageId: string;
    window: number;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionMessageSearchHit[];
  browse?(input: {
    limit: number;
    ownerUserId?: string;
    workspaceRoot?: string;
  }): SessionMessageSearchHit[];
}

export interface GatewaySessionRepository {
  create(record: GatewaySessionBindingDraft): GatewaySessionBinding;
  findLatestByExternalSession(
    adapterId: string,
    externalSessionId: string
  ): GatewaySessionBinding | null;
  listByExternalSession(adapterId: string, externalSessionId: string): GatewaySessionBinding[];
  listByRuntimeSessionId(runtimeSessionId: string): GatewaySessionBinding[];
  findByTaskId(taskId: string): GatewaySessionBinding | null;
}

