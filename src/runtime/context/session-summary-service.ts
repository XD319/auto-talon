import type {
  SessionSummaryDraft,
  SessionSummaryRecord,
  SessionSummaryRepository
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";

export interface SessionSummaryServiceDependencies {
  repository: SessionSummaryRepository;
  traceService: TraceService;
}

export class SessionSummaryService {
  public constructor(private readonly dependencies: SessionSummaryServiceDependencies) {}

  public create(draft: SessionSummaryDraft): SessionSummaryRecord {
    const sessionSummary = this.dependencies.repository.create(draft);
    if (sessionSummary.taskId !== null) {
      if (sessionSummary.trigger === "compact") {
        const compactReason =
          typeof sessionSummary.metadata.compactReason === "string"
            ? sessionSummary.metadata.compactReason
            : "message_count";
        const replacedMessageCount =
          typeof sessionSummary.metadata.replacedMessageCount === "number"
            ? Math.max(0, sessionSummary.metadata.replacedMessageCount)
            : 0;
        this.dependencies.traceService.record({
          actor: "runtime.session_memory",
          eventType: "session_compacted",
          payload: {
            reason:
              compactReason === "context_budget" ||
              compactReason === "token_budget" ||
              compactReason === "tool_call_count" ||
              compactReason === "iteration_count"
                ? compactReason
                : "message_count",
            replacedMessageCount,
            summaryMemoryId: sessionSummary.sessionSummaryId
          },
          stage: "memory",
          summary: "Session compact summary persisted",
          taskId: sessionSummary.taskId
        });
      }
      this.dependencies.traceService.record({
        actor: "runtime.session_memory",
        eventType: "session_summary_written",
        payload: {
          goal: sessionSummary.goal,
          sessionSummaryId: sessionSummary.sessionSummaryId,
          sessionId: sessionSummary.sessionId,
          trigger: sessionSummary.trigger
        },
        stage: "memory",
        summary: `Session summary persisted (${sessionSummary.trigger})`,
        taskId: sessionSummary.taskId
      });
    }
    return sessionSummary;
  }

  public findById(sessionSummaryId: string): SessionSummaryRecord | null {
    return this.dependencies.repository.findById(sessionSummaryId);
  }

  public findLatestBySession(sessionId: string): SessionSummaryRecord | null {
    return this.dependencies.repository.findLatestBySession(sessionId);
  }

  public listBySession(sessionId: string): SessionSummaryRecord[] {
    return this.dependencies.repository.listBySession(sessionId);
  }
}
