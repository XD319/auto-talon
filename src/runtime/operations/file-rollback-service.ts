import { promises as fs } from "node:fs";
import { dirname } from "node:path";

import type { AuditService } from "../../audit/audit-service.js";
import { AppError } from "../../core/app-error.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { ArtifactRecord, JsonObject } from "../../types/index.js";

export interface FileRollbackServiceDependencies {
  auditService: AuditService;
  findArtifact: (artifactId: string) => ArtifactRecord | null;
  findLatestArtifactByType: (artifactType: string) => ArtifactRecord | null;
  traceService: TraceService;
}

export interface RollbackFileArtifactResult {
  artifact: ArtifactRecord;
  deleted: boolean;
  path: string;
  restored: boolean;
}

export class FileRollbackService {
  public constructor(private readonly dependencies: FileRollbackServiceDependencies) {}

  public async rollbackFileArtifact(artifactId: string): Promise<RollbackFileArtifactResult> {
    const artifact =
      artifactId === "last"
        ? this.dependencies.findLatestArtifactByType("file_rollback")
        : this.dependencies.findArtifact(artifactId);

    if (artifact === null) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Rollback artifact ${artifactId} was not found.`
      });
    }

    if (artifact.artifactType !== "file_rollback" || !isRollbackContent(artifact.content)) {
      throw new AppError({
        code: "tool_validation_error",
        message: `Artifact ${artifact.artifactId} is not a file rollback checkpoint.`
      });
    }

    const targetPath = artifact.content.path;
    const originalExists = artifact.content.originalExists;
    if (originalExists) {
      const contentToRestore =
        typeof artifact.content.snapshotPath === "string"
          ? await fs.readFile(artifact.content.snapshotPath, "utf8")
          : artifact.content.originalContent;
      await fs.mkdir(dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, contentToRestore, "utf8");
    } else {
      await fs.rm(targetPath, { force: true });
    }

    this.dependencies.traceService.record({
      actor: "runtime.rollback",
      eventType: "file_rollback",
      payload: {
        artifactId: artifact.artifactId,
        operation: artifact.content.operation,
        originalExists,
        path: targetPath,
        restoredHash: artifact.content.sha256
      },
      stage: "tooling",
      summary: originalExists ? `Restored ${targetPath}` : `Removed ${targetPath}`,
      taskId: artifact.taskId
    });

    this.dependencies.auditService.record({
      action: "file_rollback",
      actor: "runtime.rollback",
      approvalId: null,
      outcome: "succeeded",
      payload: {
        artifactId: artifact.artifactId,
        operation: artifact.content.operation,
        originalExists,
        path: targetPath
      },
      summary: originalExists ? `Restored ${targetPath}` : `Removed ${targetPath}`,
      taskId: artifact.taskId,
      toolCallId: artifact.toolCallId
    });

    return {
      artifact,
      deleted: !originalExists,
      path: targetPath,
      restored: originalExists
    };
  }
}

interface RollbackArtifactContent extends JsonObject {
  createdAt: string;
  operation: string;
  originalContent: string;
  originalExists: true;
  path: string;
  snapshotPath?: string;
  sha256: string;
}

interface DeleteRollbackArtifactContent extends JsonObject {
  createdAt: string;
  operation: string;
  originalContent: null;
  originalExists: false;
  path: string;
  sha256: null;
}

function isRollbackContent(
  value: ArtifactRecord["content"]
): value is RollbackArtifactContent | DeleteRollbackArtifactContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const content = value as Record<string, unknown>;
  if (typeof content.path !== "string" || typeof content.operation !== "string") {
    return false;
  }

  if (content.originalExists === true) {
    return typeof content.originalContent === "string" && typeof content.sha256 === "string";
  }

  return content.originalExists === false && content.originalContent === null;
}
