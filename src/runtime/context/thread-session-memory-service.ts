import type {
  ThreadSessionMemoryDraft,
  ThreadSessionMemoryRecord,
  ThreadSessionMemoryRepository
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";

export interface ThreadSessionMemoryServiceDependencies {
  repository: ThreadSessionMemoryRepository;
  traceService: TraceService;
}

export class ThreadSessionMemoryService {
  public constructor(private readonly dependencies: ThreadSessionMemoryServiceDependencies) {}

  public create(draft: ThreadSessionMemoryDraft): ThreadSessionMemoryRecord {
    const sessionMemory = this.dependencies.repository.create(draft);
    if (sessionMemory.taskId !== null) {
      if (sessionMemory.trigger === "compact") {
        const compactReason =
          typeof sessionMemory.metadata.compactReason === "string"
            ? sessionMemory.metadata.compactReason
            : "message_count";
        const replacedMessageCount =
          typeof sessionMemory.metadata.replacedMessageCount === "number"
            ? Math.max(0, sessionMemory.metadata.replacedMessageCount)
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
            summaryMemoryId: sessionMemory.sessionMemoryId
          },
          stage: "memory",
          summary: "Session compact summary persisted",
          taskId: sessionMemory.taskId
        });
      }
      this.dependencies.traceService.record({
        actor: "runtime.session_memory",
        eventType: "thread_session_memory_written",
        payload: {
          goal: sessionMemory.goal,
          sessionMemoryId: sessionMemory.sessionMemoryId,
          threadId: sessionMemory.threadId,
          trigger: sessionMemory.trigger
        },
        stage: "memory",
        summary: `Thread session memory persisted (${sessionMemory.trigger})`,
        taskId: sessionMemory.taskId
      });
    }
    return sessionMemory;
  }

  public findById(sessionMemoryId: string): ThreadSessionMemoryRecord | null {
    return this.dependencies.repository.findById(sessionMemoryId);
  }

  public findLatestByThread(threadId: string): ThreadSessionMemoryRecord | null {
    return this.dependencies.repository.findLatestByThread(threadId);
  }

  public listByThread(threadId: string): ThreadSessionMemoryRecord[] {
    return this.dependencies.repository.listByThread(threadId);
  }
}
