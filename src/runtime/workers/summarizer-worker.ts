import type { ContextCompactor, ThreadSessionMemoryService } from "../context/index.js";
import type {
  ProviderToolDescriptor,
  SessionCompactInput,
  SessionCompactResult,
  TaskRecord,
  ThreadSessionMemoryRecord
} from "../../types/index.js";

export interface SummarizerWorkerDependencies {
  contextCompactor: ContextCompactor;
  threadSessionMemoryService: ThreadSessionMemoryService;
}

export interface SummarizerWorkerInput {
  compactResult: SessionCompactResult;
  compactInput: SessionCompactInput & {
    reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count";
  };
  task: TaskRecord;
  availableTools: ProviderToolDescriptor[];
  runId: string | null;
}

export interface SummarizerWorkerOutput {
  sessionMemory: ThreadSessionMemoryRecord | null;
  compacted: boolean;
  summary: string;
}

export class SummarizerWorker {
  public constructor(private readonly dependencies: SummarizerWorkerDependencies) {}

  public execute(input: SummarizerWorkerInput): Promise<SummarizerWorkerOutput> {
    if (!input.compactResult.triggered || input.task.threadId === null || input.task.threadId === undefined) {
      return Promise.resolve({
        compacted: input.compactResult.triggered,
        sessionMemory: null,
        summary: "Compaction did not produce thread session memory."
      });
    }

    const draft = this.dependencies.contextCompactor.buildSessionMemory({
      availableTools: input.availableTools,
      compact: input.compactInput,
      task: input.task
    });
    const sessionMemory = this.dependencies.threadSessionMemoryService.create({
      ...draft,
      runId: input.runId,
      threadId: input.task.threadId,
      trigger: "compact"
    });
    return Promise.resolve({
      compacted: true,
      sessionMemory,
      summary: sessionMemory.summary
    });
  }
}
