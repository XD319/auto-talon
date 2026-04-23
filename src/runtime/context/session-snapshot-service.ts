import type {
  ThreadSnapshotDraft,
  ThreadSnapshotRecord,
  ThreadSnapshotRepository
} from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";

export interface SessionSnapshotServiceDependencies {
  snapshotRepository: ThreadSnapshotRepository;
  traceService: TraceService;
}

export class SessionSnapshotService {
  public constructor(private readonly dependencies: SessionSnapshotServiceDependencies) {}

  public createSnapshot(draft: ThreadSnapshotDraft): ThreadSnapshotRecord {
    const snapshot = this.dependencies.snapshotRepository.create(draft);
    if (snapshot.taskId !== null) {
      this.dependencies.traceService.record({
        actor: "runtime.snapshot",
        eventType: "thread_snapshot_created",
        payload: {
          goal: snapshot.goal,
          snapshotId: snapshot.snapshotId,
          threadId: snapshot.threadId,
          trigger: snapshot.trigger
        },
        stage: "memory",
        summary: `Thread snapshot persisted (${snapshot.trigger})`,
        taskId: snapshot.taskId
      });
    }
    return snapshot;
  }

  public findLatestByThread(threadId: string): ThreadSnapshotRecord | null {
    return this.dependencies.snapshotRepository.findLatestByThread(threadId);
  }

  public listByThread(threadId: string): ThreadSnapshotRecord[] {
    return this.dependencies.snapshotRepository.listByThread(threadId);
  }

  public findById(snapshotId: string): ThreadSnapshotRecord | null {
    return this.dependencies.snapshotRepository.findById(snapshotId);
  }
}
