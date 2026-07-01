import type { ContextCompactor, SessionSummaryService } from "../context/index.js";
import type {
  ProviderToolDescriptor,
  SessionCompactInput,
  SessionCompactResult,
  TaskRecord,
  SessionSummaryRecord
} from "../../types/index.js";

export interface SummarizerWorkerDependencies {
  contextCompactor: ContextCompactor;
  sessionSummaryService: SessionSummaryService;
}

export interface SummarizerWorkerInput {
  compactResult: SessionCompactResult;
  compactInput: SessionCompactInput & {
    reason: "message_count" | "context_budget" | "token_budget" | "tool_call_count" | "iteration_count";
  };
  task: TaskRecord;
  availableTools: ProviderToolDescriptor[];
  runId: string | null;
}

export interface SummarizerWorkerOutput {
  sessionSummary: SessionSummaryRecord | null;
  compacted: boolean;
  summary: string;
}

export class SummarizerWorker {
  public constructor(private readonly dependencies: SummarizerWorkerDependencies) {}

  public execute(input: SummarizerWorkerInput): Promise<SummarizerWorkerOutput> {
    if (!input.compactResult.triggered || input.task.sessionId === null || input.task.sessionId === undefined) {
      return Promise.resolve({
        compacted: input.compactResult.triggered,
        sessionSummary: null,
        summary: "Compaction did not produce session summary."
      });
    }

    const previousSessionSummary =
      this.dependencies.sessionSummaryService.findLatestBySession(input.task.sessionId);
    const draft = this.dependencies.contextCompactor.buildSessionSummary({
      availableTools: input.availableTools,
      compact: input.compactInput,
      previousSessionSummary,
      task: input.task
    });
    const sessionSummary = this.dependencies.sessionSummaryService.create({
      ...draft,
      metadata: {
        ...(draft.metadata ?? {}),
        compactReason: input.compactInput.reason,
        replacedMessageCount: Math.max(
          0,
          input.compactInput.messages.length - input.compactResult.replacementMessages.length
        )
      },
      runId: input.runId,
      sessionId: input.task.sessionId,
      trigger: "compact"
    });
    return Promise.resolve({
      compacted: true,
      sessionSummary,
      summary: sessionSummary.summary
    });
  }
}
