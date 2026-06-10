import type { JsonObject } from "./common.js";
import type { AuditLogRecord } from "./audit.js";
import type { TraceEvent } from "./trace.js";
import type { RuntimeOutputEvent } from "./output.js";
import type { InboxDeliveryEvent, InboxItem, InboxListQuery } from "./inbox.js";
import type {
  ScheduleDeliveryTarget,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleStatusSummary
} from "./schedule.js";

export type AdapterCapabilityName =
  | "textInteraction"
  | "approvalInteraction"
  | "fileCapability"
  | "attachmentCapability"
  | "streamingCapability"
  | "structuredCardCapability";

export interface AdapterCapabilitySupport {
  supported: boolean;
  detail?: string;
}

export interface AdapterCapabilityDeclaration {
  approvalInteraction: AdapterCapabilitySupport;
  attachmentCapability: AdapterCapabilitySupport;
  fileCapability: AdapterCapabilitySupport;
  streamingCapability: AdapterCapabilitySupport;
  structuredCardCapability: AdapterCapabilitySupport;
  textInteraction: AdapterCapabilitySupport;
}

export type AdapterKind =
  | "cli"
  | "tui"
  | "webhook"
  | "sdk"
  | "slack"
  | "telegram"
  | "discord"
  | "mcp_client"
  | "mcp_server"
  | "remote_bridge"
  | "teammate";

export type AdapterLifecycleState = "created" | "starting" | "running" | "stopped";

export interface AdapterDescriptor {
  adapterId: string;
  contractVersion: number;
  description: string;
  displayName: string;
  kind: AdapterKind;
  lifecycleState: AdapterLifecycleState;
  capabilities: AdapterCapabilityDeclaration;
}

export interface GatewayRequesterIdentity {
  externalSessionId: string;
  externalUserId: string | null;
  externalUserLabel: string | null;
}

export interface GatewayIdentityBinding {
  adapterId: string;
  externalUserId: string | null;
  runtimeUserId: string;
}

export interface GatewaySessionBinding {
  adapterId: string;
  createdAt: string;
  externalSessionId: string;
  externalUserId: string | null;
  metadata: JsonObject;
  runtimeSessionId: string | null;
  runtimeUserId: string;
  sessionBindingId: string;
  taskId: string;
  updatedAt: string;
}

export interface GatewayTaskRequest {
  agentProfileId?: "executor" | "planner" | "reviewer";
  continuation?: "new" | "resume-latest";
  cwd?: string;
  interactionRequirements?: Partial<Record<AdapterCapabilityName, "preferred" | "required">>;
  metadata?: JsonObject;
  requester: GatewayRequesterIdentity;
  taskInput: string;
  timeoutMs?: number;
}

export interface GatewayCapabilityNotice {
  capability: AdapterCapabilityName;
  fallbackBehavior: string;
  message: string;
  severity: "info" | "warning";
}

export type GatewayTaskEvent =
  | {
      kind: "trace";
      taskId: string;
      trace: TraceEvent;
    }
  | {
      kind: "audit";
      audit: AuditLogRecord;
      taskId: string;
    }
  | {
      kind: "progress";
      detail: string;
      taskId: string;
    }
  | {
      kind: "output";
      output: RuntimeOutputEvent;
      taskId: string;
    }
  | {
      kind: "gateway_notice";
      notice: GatewayCapabilityNotice;
      taskId: string;
    };

export type GatewayInboxFilter = InboxListQuery;

export interface GatewayTaskResultView {
  errorCode: string | null;
  errorMessage: string | null;
  output: string | null;
  pendingApprovalContext?: {
    detailLines: string[];
    riskLevel: string;
    summaryLine: string;
    toolName: string;
  };
  pendingApprovalId: string | null;
  status: string;
  taskId: string;
}

export interface GatewayTaskLaunchResult {
  adapter: AdapterDescriptor;
  notices: GatewayCapabilityNotice[];
  result: GatewayTaskResultView;
  sessionBinding: GatewaySessionBinding;
}

export interface GatewayTaskStreamObserver {
  onEvent(event: GatewayTaskEvent): void;
  signal?: AbortSignal;
}

export interface GatewayScheduleCreateRequest {
  agentProfileId?: "executor" | "planner" | "reviewer";
  cron?: string | null;
  cwd?: string;
  every?: string | null;
  input: string;
  messageId?: string | null;
  metadata?: JsonObject;
  name: string;
  requester: GatewayRequesterIdentity;
  runAt?: string | null;
  sessionId?: string | null;
  timezone?: string | null;
  deliveryTargets?: ScheduleDeliveryTarget[];
}

export interface GatewayScheduleUpdateRequest {
  agentProfileId?: "executor" | "planner" | "reviewer";
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cron?: string | null;
  deliveryTargets?: ScheduleDeliveryTarget[];
  every?: string | null;
  input?: string;
  maxAttempts?: number;
  metadata?: JsonObject;
  name?: string;
  runAt?: string | null;
  sessionId?: string | null;
  timezone?: string | null;
}

export interface GatewayTaskSnapshot {
  adapterSource: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    runtimeUserId: string;
  } | null;
  audit: AuditLogRecord[];
  notices: GatewayCapabilityNotice[];
  output: RuntimeOutputEvent[];
  task: GatewayTaskResultView;
  trace: TraceEvent[];
}

export interface GatewayRuntimeApi {
  createSchedule(adapter: AdapterDescriptor, request: GatewayScheduleCreateRequest): ScheduleRecord;
  getTaskSnapshot(taskId: string): GatewayTaskSnapshot | null;
  listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[];
  listSchedules(query?: ScheduleListQuery): ScheduleRecord[];
  listInbox(filter?: GatewayInboxFilter): InboxItem[];
  markInboxDone(inboxId: string, reviewerRuntimeUserId: string): InboxItem;
  archiveSchedule(scheduleId: string): ScheduleRecord;
  pauseSchedule(scheduleId: string): ScheduleRecord;
  registerOutboundAdapter(adapterId: string, adapter: OutboundResponseAdapter): void;
  resolveApproval(params: {
    adapterId: string;
    allowScope?: "once" | "session" | "always";
    approvalId: string;
    decision: "allow" | "deny";
    reviewerExternalUserId: string | null;
    reviewerRuntimeUserId: string;
  }): Promise<GatewayTaskLaunchResult | null>;
  resumeSchedule(scheduleId: string): ScheduleRecord;
  runScheduleNow(scheduleId: string): ScheduleRunRecord;
  scheduleStatus(): ScheduleStatusSummary;
  showSchedule(scheduleId: string): ScheduleRecord | null;
  submitTask(
    adapter: AdapterDescriptor,
    request: GatewayTaskRequest,
    observer?: GatewayTaskStreamObserver
  ): Promise<GatewayTaskLaunchResult>;
  subscribeToCompletion(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void;
  subscribeToInbox(filter: GatewayInboxFilter, listener: (event: InboxDeliveryEvent) => void): () => void;
  subscribeToTaskEvents(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void;
  updateSchedule(scheduleId: string, request: GatewayScheduleUpdateRequest): ScheduleRecord;
}

export interface AdapterLifecycle {
  start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void>;
  stop(): Promise<void>;
}

export interface InboundMessageAdapter extends AdapterLifecycle {
  descriptor: AdapterDescriptor;
}

export interface OutboundResponseAdapter {
  sendInboxEvent?(event: InboxDeliveryEvent): Promise<void>;
  sendCapabilityNotice?(taskId: string, notice: GatewayCapabilityNotice): Promise<void>;
  sendEvent?(event: GatewayTaskEvent): Promise<void>;
  sendResult?(result: GatewayTaskLaunchResult): Promise<void>;
}
