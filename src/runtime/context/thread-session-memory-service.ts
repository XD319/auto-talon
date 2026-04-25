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
        this.dependencies.traceService.record({
          actor: "runtime.session_memory",
          eventType: "session_compacted",
          payload: {
            reason: "message_count",
            replacedMessageCount: 0,
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
