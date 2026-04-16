import { randomUUID } from "node:crypto";

import type { AuditLogDraft, AuditLogRecord, AuditLogRepository } from "../types";

export class AuditService {
  public constructor(private readonly auditLogRepository: AuditLogRepository) {}

  public record(
    event: Omit<AuditLogDraft, "auditId" | "createdAt"> &
      Partial<Pick<AuditLogDraft, "auditId" | "createdAt">>
  ): AuditLogRecord {
    return this.auditLogRepository.append({
      ...event,
      auditId: event.auditId ?? randomUUID(),
      createdAt: event.createdAt ?? new Date().toISOString()
    });
  }

  public listByTaskId(taskId: string): AuditLogRecord[] {
    return this.auditLogRepository.listByTaskId(taskId);
  }
}
