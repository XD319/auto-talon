import type { AuditService } from "../audit/audit-service";
import type { TraceService } from "../tracing/trace-service";
import type { AgentApplicationService } from "../runtime/application-service";
import type {
  AdapterDescriptor,
  AdapterCapabilityName,
  GatewayRuntimeApi,
  GatewayTaskEvent,
  GatewayTaskLaunchResult,
  GatewayTaskRequest,
  GatewayTaskSnapshot,
  GatewayTaskResultView,
  RuntimeRunOptions
} from "../types";

import { collectCapabilityNotices } from "./capability-policy";
import type { GatewayIdentityMapper } from "./identity-mapper";
import type { GatewaySessionMapper } from "./session-mapper";

export interface GatewayRuntimeFacadeDependencies {
  applicationService: AgentApplicationService;
  auditService: AuditService;
  createRunOptions: (taskInput: string, cwd: string) => RuntimeRunOptions;
  defaultCwd: string;
  identityMapper: GatewayIdentityMapper;
  sessionMapper: GatewaySessionMapper;
  traceService: TraceService;
}

export class GatewayRuntimeFacade implements GatewayRuntimeApi {
  public constructor(private readonly dependencies: GatewayRuntimeFacadeDependencies) {}

  public async submitTask(
    adapter: AdapterDescriptor,
    request: GatewayTaskRequest
  ): Promise<GatewayTaskLaunchResult> {
    const identityBinding = this.dependencies.identityMapper.bind(adapter.adapterId, request.requester);
    const runOptions = this.dependencies.createRunOptions(
      request.taskInput,
      request.cwd ?? this.dependencies.defaultCwd
    );
    runOptions.userId = identityBinding.runtimeUserId;
    runOptions.agentProfileId = request.agentProfileId ?? runOptions.agentProfileId;
    runOptions.metadata = {
      ...(request.metadata ?? {}),
      gateway: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: identityBinding.runtimeUserId
      }
    };

    if (request.timeoutMs !== undefined) {
      runOptions.timeoutMs = request.timeoutMs;
    }

    const run = await this.dependencies.applicationService.runTask(runOptions);
    const sessionBinding = this.dependencies.sessionMapper.bindTask({
      adapterId: adapter.adapterId,
      externalSessionId: request.requester.externalSessionId,
      externalUserId: request.requester.externalUserId,
      metadata: request.metadata ?? {},
      runtimeUserId: identityBinding.runtimeUserId,
      taskId: run.task.taskId
    });

    this.dependencies.traceService.record({
      actor: `gateway.${adapter.adapterId}`,
      eventType: "gateway_request_received",
      payload: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: identityBinding.runtimeUserId
      },
      stage: "gateway",
      summary: `Gateway request accepted from ${adapter.adapterId}`,
      taskId: run.task.taskId
    });

    this.dependencies.auditService.record({
      action: "gateway_request",
      actor: `gateway.${adapter.adapterId}`,
      outcome: "attempted",
      payload: {
        adapterId: adapter.adapterId,
        adapterKind: adapter.kind,
        externalSessionId: request.requester.externalSessionId,
        externalUserId: request.requester.externalUserId,
        runtimeUserId: identityBinding.runtimeUserId
      },
      summary: `Gateway request entered from ${adapter.adapterId}`,
      taskId: run.task.taskId,
      toolCallId: null,
      approvalId: null
    });

    const notices = collectCapabilityNotices(
      adapter.adapterId,
      adapter.capabilities,
      request,
      run.task
    );

    for (const notice of notices) {
      this.dependencies.traceService.record({
        actor: `gateway.${adapter.adapterId}`,
        eventType: "gateway_capability_degraded",
        payload: {
          adapterId: adapter.adapterId,
          capability: notice.capability,
          fallbackBehavior: notice.fallbackBehavior,
          message: notice.message
        },
        stage: "gateway",
        summary: `Gateway fallback applied for ${notice.capability}`,
        taskId: run.task.taskId
      });

      this.dependencies.auditService.record({
        action: "gateway_capability_degraded",
        actor: `gateway.${adapter.adapterId}`,
        outcome: "attempted",
        payload: {
          adapterId: adapter.adapterId,
          capability: notice.capability,
          fallbackBehavior: notice.fallbackBehavior,
          message: notice.message,
          severity: notice.severity
        },
        summary: `Gateway fallback applied for ${notice.capability}`,
        taskId: run.task.taskId,
        toolCallId: null,
        approvalId: null
      });
    }

    return {
      adapter,
      notices,
      result: toGatewayTaskResult(run.task.taskId, run.task.status, run.output, run.error),
      sessionBinding
    };
  }

  public getTaskSnapshot(taskId: string): GatewayTaskSnapshot | null {
    const details = this.dependencies.applicationService.showTask(taskId);
    if (details.task === null) {
      return null;
    }

    const sessionBinding = this.dependencies.sessionMapper.findByTaskId(taskId);
    const notices = this.dependencies.applicationService
      .auditTask(taskId)
      .filter((entry) => entry.action === "gateway_capability_degraded")
      .map((entry) => ({
        capability: readString(entry.payload.capability) as AdapterCapabilityName,
        fallbackBehavior: readString(entry.payload.fallbackBehavior),
        message: readString(entry.payload.message),
        severity:
          entry.payload.severity === "warning" ? ("warning" as const) : ("info" as const)
      }));

    return {
      adapterSource:
        sessionBinding === null
          ? null
          : {
              adapterId: sessionBinding.adapterId,
              externalSessionId: sessionBinding.externalSessionId,
              externalUserId: sessionBinding.externalUserId,
              runtimeUserId: sessionBinding.runtimeUserId
            },
      audit: details.task === null ? [] : this.dependencies.applicationService.auditTask(taskId),
      notices,
      task: {
        errorCode: details.task.errorCode,
        errorMessage: details.task.errorMessage,
        output: details.task.finalOutput,
        status: details.task.status,
        taskId: details.task.taskId
      },
      trace: details.trace
    };
  }

  public subscribeToTaskEvents(taskId: string, listener: (event: GatewayTaskEvent) => void): () => void {
    const unsubscribeTrace = this.dependencies.traceService.subscribe((trace) => {
      if (trace.taskId !== taskId) {
        return;
      }

      listener({
        kind: "trace",
        taskId,
        trace
      });
    });

    const unsubscribeAudit = this.dependencies.auditService.subscribe((audit) => {
      if (audit.taskId !== taskId) {
        return;
      }

      listener({
        kind: "audit",
        audit,
        taskId
      });
    });

    return () => {
      unsubscribeTrace();
      unsubscribeAudit();
    };
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toGatewayTaskResult(
  taskId: string,
  status: string,
  output: string | null,
  error:
    | {
        code: string;
        message: string;
      }
    | undefined
): GatewayTaskResultView {
  return {
    errorCode: error?.code ?? null,
    errorMessage: error?.message ?? null,
    output,
    status,
    taskId
  };
}
