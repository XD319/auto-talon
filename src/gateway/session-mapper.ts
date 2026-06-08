import { randomUUID } from "node:crypto";

import type {
  GatewaySessionBinding,
  GatewaySessionRepository,
  JsonObject,
  TaskRecord
} from "../types/index.js";

export interface GatewaySessionMapper {
  bindTask(params: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    metadata: JsonObject;
    runtimeSessionId: string | null;
    runtimeUserId: string;
    taskId: string;
  }): GatewaySessionBinding;
  resolveContinuation(params: {
    adapterId: string;
    externalSessionId: string;
  }): { previousTaskId: string; runtimeSessionId: string | null; runtimeUserId: string } | null;
  findByTaskId(taskId: string): GatewaySessionBinding | null;
}

export interface RepositoryBackedGatewaySessionMapperDependencies {
  findTaskById: (taskId: string) => TaskRecord | null;
  repository: GatewaySessionRepository;
}

export class RepositoryBackedGatewaySessionMapper implements GatewaySessionMapper {
  public constructor(private readonly dependencies: RepositoryBackedGatewaySessionMapperDependencies) {}

  public bindTask(params: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    metadata: JsonObject;
    runtimeSessionId: string | null;
    runtimeUserId: string;
    taskId: string;
  }): GatewaySessionBinding {
    return this.dependencies.repository.create({
      adapterId: params.adapterId,
      externalSessionId: params.externalSessionId,
      externalUserId: params.externalUserId,
      metadata: params.metadata,
      runtimeSessionId: params.runtimeSessionId,
      runtimeUserId: params.runtimeUserId,
      sessionBindingId: randomUUID(),
      taskId: params.taskId
    });
  }

  public findByTaskId(taskId: string): GatewaySessionBinding | null {
    return this.dependencies.repository.findByTaskId(taskId);
  }

  public resolveContinuation(params: {
    adapterId: string;
    externalSessionId: string;
  }): { previousTaskId: string; runtimeSessionId: string | null; runtimeUserId: string } | null {
    const latest = this.dependencies.repository.findLatestByExternalSession(
      params.adapterId,
      params.externalSessionId
    );
    if (latest === null) {
      return null;
    }
    const previousTask = this.dependencies.findTaskById(latest.taskId);
    const runtimeSessionId =
      latest.runtimeSessionId ?? previousTask?.sessionId ?? null;
    return {
      previousTaskId: latest.taskId,
      runtimeSessionId,
      runtimeUserId: latest.runtimeUserId
    };
  }
}
