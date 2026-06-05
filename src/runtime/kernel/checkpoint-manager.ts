import { AppError } from "../app-error.js";
import {
  DEDUPLICATABLE_CAPABILITIES,
  historyHasSuccessfulWrite,
  rebuildSignaturesFromMessages
} from "../kernel-support.js";
import type {
  ConversationMessage,
  ContextFragment,
  ExecutionCheckpointRecord,
  ExecutionCheckpointRepository,
  ProviderToolCall,
  ProviderToolDescriptor,
  TaskRecord
} from "../../types/index.js";
import type { ToolOrchestrator } from "../../tools/index.js";

export interface CheckpointManagerDependencies {
  executionCheckpointRepository: ExecutionCheckpointRepository;
  toolOrchestrator: ToolOrchestrator;
}

export interface SaveCheckpointInput {
  iteration: number;
  memoryContext: ContextFragment[];
  messages: ConversationMessage[];
  pendingClarifyPromptId: string | null;
  pendingToolCalls: ProviderToolCall[];
  taskId: string;
}

export interface ResumeCheckpointState {
  checkpoint: ExecutionCheckpointRecord;
  toolCallSignatures: Map<string, { iteration: number; toolCallId: string }>;
  writeToolSucceeded: boolean;
}

export class CheckpointManager {
  public constructor(private readonly dependencies: CheckpointManagerDependencies) {}

  public loadForResume(task: TaskRecord): ResumeCheckpointState {
    const checkpoint = this.dependencies.executionCheckpointRepository.findByTaskId(task.taskId);
    if (checkpoint === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${task.taskId} has no execution checkpoint to resume.`
      });
    }
    return {
      checkpoint,
      toolCallSignatures: rebuildSignaturesFromMessages(
        checkpoint.messages,
        (toolName) => this.isDeduplicatable(toolName)
      ),
      writeToolSucceeded: historyHasSuccessfulWrite(
        checkpoint.messages,
        (toolName) => this.isWriteTool(toolName)
      )
    };
  }

  public save(input: SaveCheckpointInput): ExecutionCheckpointRecord {
    return this.dependencies.executionCheckpointRepository.save({
      iteration: input.iteration,
      memoryContext: input.memoryContext,
      messages: input.messages,
      pendingClarifyPromptId: input.pendingClarifyPromptId,
      pendingToolCalls: input.pendingToolCalls,
      taskId: input.taskId,
      updatedAt: new Date().toISOString()
    });
  }

  public delete(taskId: string): void {
    this.dependencies.executionCheckpointRepository.delete(taskId);
  }

  private isDeduplicatable(toolName: string): boolean {
    const descriptor = this.describe(toolName);
    return descriptor !== null && DEDUPLICATABLE_CAPABILITIES.has(descriptor.capability);
  }

  private isWriteTool(toolName: string): boolean {
    const descriptor = this.describe(toolName);
    return descriptor?.capability === "filesystem.write" || toolName.includes("write");
  }

  private describe(toolName: string): ProviderToolDescriptor | null {
    return this.dependencies.toolOrchestrator.describeTool(toolName);
  }
}
