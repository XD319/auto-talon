import { randomUUID } from "node:crypto";

import { AppError } from "../app-error.js";
import type {
  AgentApplicationServiceDependencies,
  RunTaskResult
} from "../application-service.js";
import type {
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  RuntimeRunOptions,
  ScheduleRunRecord,
  TaskRecord,
  ThreadCommitmentState,
  ThreadLineageRecord,
  ThreadRecord,
  ThreadRunRecord,
  ThreadSessionMemoryRecord
} from "../../types/index.js";

export class ThreadFacade {
  public constructor(
    private readonly dependencies: AgentApplicationServiceDependencies,
    private readonly projectAssistantOutput: (
      threadId: string | null,
      taskId: string,
      output: string | null
    ) => void
  ) {}

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    try {
      const resolvedThread = this.dependencies.threadService.getOrCreateThread({
        agentProfileId: options.agentProfileId,
        cwd: options.cwd,
        ownerUserId: options.userId,
        providerName: this.dependencies.provider.name,
        ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
        title: options.taskInput.slice(0, 80)
      });
      const result = await this.dependencies.executionKernel.run({
        ...options,
        threadId: resolvedThread.threadId
      });
      this.projectAssistantOutput(result.task.threadId ?? null, result.task.taskId, result.output ?? null);
      return {
        output: result.output,
        task: result.task
      };
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError({
              code: "provider_error",
              message: error instanceof Error ? error.message : "Unknown runtime error"
            });

      const taskId =
        typeof appError.details?.taskId === "string" ? appError.details.taskId : null;
      const task = taskId === null ? null : this.dependencies.findTask(taskId);
      if (task === null) {
        throw appError;
      }

      return {
        error: appError,
        output: null,
        task
      };
    }
  }

  public listTasks(): TaskRecord[] {
    return this.dependencies.listTasks();
  }

  public createThread(input: {
    agentProfileId: ThreadRecord["agentProfileId"];
    cwd: string;
    ownerUserId: string;
    providerName?: string;
    title?: string;
  }): ThreadRecord {
    return this.dependencies.threadService.createThread({
      agentProfileId: input.agentProfileId,
      cwd: input.cwd,
      ownerUserId: input.ownerUserId,
      providerName: input.providerName ?? this.dependencies.provider.name,
      threadId: randomUUID(),
      title: input.title?.trim().length ? input.title : "Untitled thread"
    });
  }

  public listThreads(status?: ThreadRecord["status"]): ThreadRecord[] {
    const threads = this.dependencies.listThreads();
    if (status === undefined) {
      return threads;
    }
    return threads.filter((thread) => thread.status === status);
  }

  public showThread(threadId: string): {
    commitments: CommitmentRecord[];
    inboxItems: InboxItem[];
    nextActions: NextActionRecord[];
    state: ThreadCommitmentState;
    thread: ThreadRecord | null;
    runs: ThreadRunRecord[];
    lineage: ThreadLineageRecord[];
    scheduleRuns: ScheduleRunRecord[];
  } {
    const thread = this.dependencies.findThread(threadId);
    if (thread === null) {
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        runs: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: null,
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        thread: null
      };
    }
    return {
      commitments: this.dependencies.commitmentService.list({ threadId }),
      inboxItems: this.dependencies.listInboxItems({ threadId }),
      nextActions: this.dependencies.nextActionService.list({ threadId }),
      thread,
      runs: this.dependencies.listThreadRuns(threadId),
      lineage: this.dependencies.listThreadLineage(threadId),
      scheduleRuns: this.dependencies.listScheduleRunsByThread(threadId),
      state: this.dependencies.threadCommitmentProjector.project(threadId)
    };
  }

  public archiveThread(threadId: string): ThreadRecord {
    return this.dependencies.threadService.archiveThread(threadId);
  }

  public listThreadSnapshots(threadId: string): ThreadSessionMemoryRecord[] {
    return this.dependencies.listThreadSessionMemories(threadId);
  }

  public showThreadSnapshot(snapshotId: string): ThreadSessionMemoryRecord | null {
    return this.dependencies.findThreadSessionMemory(snapshotId);
  }

  public searchThreadSnapshots(input: {
    limit: number;
    query: string;
    threadId?: string;
    excludeThreadId?: string | null;
  }) {
    return this.dependencies.searchThreadSessionMemories(input);
  }

  public async continueThread(
    threadId: string,
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    const options = this.dependencies.resumePacketBuilder.buildResumePacket(threadId, input, overrides);
    return this.runTask(options);
  }

  public async continueLatest(
    input: string | undefined,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    const ownerUserId = overrides?.userId ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
    const latest = this.dependencies.threadService.findLatestThread(ownerUserId);
    if (latest === null) {
      throw new Error("No threads found for current user.");
    }
    const resolvedInput =
      input ??
      this.dependencies.threadCommitmentProjector.project(latest.threadId).nextAction?.title ??
      null;
    if (resolvedInput === null) {
      throw new Error("No next action found for latest thread. Provide an explicit task input.");
    }
    return this.continueThread(latest.threadId, resolvedInput, overrides);
  }
}
