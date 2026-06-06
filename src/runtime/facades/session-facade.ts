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
  SessionCommitmentState,
  SessionLineageRecord,
  SessionRecord,
  SessionTaskRecord,
  SessionSummaryRecord
} from "../../types/index.js";

export class SessionFacade {
  public constructor(
    private readonly dependencies: AgentApplicationServiceDependencies,
    private readonly projectAssistantOutput: (
      sessionId: string | null,
      taskId: string,
      output: string | null
    ) => void
  ) {}

  public async runTask(options: RuntimeRunOptions): Promise<RunTaskResult> {
    try {
      const resolvedSession = this.dependencies.sessionService.getOrCreateSession({
        agentProfileId: options.agentProfileId,
        cwd: options.cwd,
        ownerUserId: options.userId,
        providerName: this.dependencies.provider.name,
        ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
        title: options.taskInput.slice(0, 80)
      });
      const result = await this.dependencies.executionKernel.run({
        ...options,
        sessionId: resolvedSession.sessionId
      });
      this.projectAssistantOutput(result.task.sessionId ?? null, result.task.taskId, result.output ?? null);
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

  public createSession(input: {
    agentProfileId: SessionRecord["agentProfileId"];
    cwd: string;
    ownerUserId: string;
    providerName?: string;
    title?: string;
  }): SessionRecord {
    return this.dependencies.sessionService.createSession({
      agentProfileId: input.agentProfileId,
      cwd: input.cwd,
      ownerUserId: input.ownerUserId,
      providerName: input.providerName ?? this.dependencies.provider.name,
      sessionId: randomUUID(),
      title: input.title?.trim().length ? input.title : "Untitled session"
    });
  }

  public listSessions(status?: SessionRecord["status"]): SessionRecord[] {
    const sessions = this.dependencies.listSessions();
    if (status === undefined) {
      return sessions;
    }
    return sessions.filter((session) => session.status === status);
  }

  public showSession(sessionId: string): {
    commitments: CommitmentRecord[];
    inboxItems: InboxItem[];
    nextActions: NextActionRecord[];
    state: SessionCommitmentState;
    session: SessionRecord | null;
    tasks: SessionTaskRecord[];
    lineage: SessionLineageRecord[];
    scheduleRuns: ScheduleRunRecord[];
  } {
    const session = this.dependencies.findSession(sessionId);
    if (session === null) {
      return {
        commitments: [],
        inboxItems: [],
        lineage: [],
        nextActions: [],
        tasks: [],
        scheduleRuns: [],
        state: {
          activeNextActions: [],
          blockedReason: null,
          currentObjective: null,
          nextAction: null,
          openCommitments: [],
          pendingDecision: null
        },
        session: null
      };
    }
    return {
      commitments: this.dependencies.commitmentService.list({ sessionId }),
      inboxItems: this.dependencies.listInboxItems({ sessionId }),
      nextActions: this.dependencies.nextActionService.list({ sessionId }),
      session,
      tasks: this.dependencies.listSessionTasks(sessionId),
      lineage: this.dependencies.listSessionLineage(sessionId),
      scheduleRuns: this.dependencies.listScheduleRunsBySession(sessionId),
      state: this.dependencies.sessionCommitmentProjector.project(sessionId)
    };
  }

  public archiveSession(sessionId: string): SessionRecord {
    return this.dependencies.sessionService.archiveSession(sessionId);
  }

  public listSessionSummaries(sessionId: string): SessionSummaryRecord[] {
    return this.dependencies.listSessionSummaries(sessionId);
  }

  public showSessionSummary(snapshotId: string): SessionSummaryRecord | null {
    return this.dependencies.findSessionSummary(snapshotId);
  }

  public searchSessionSummaries(input: {
    limit: number;
    query: string;
    sessionId?: string;
    excludeSessionId?: string | null;
  }) {
    return this.dependencies.searchSessionSummaries(input);
  }

  public ensureRuntimeSession(
    sessionId: string,
    input?: {
      agentProfileId?: SessionRecord["agentProfileId"];
      cwd?: string;
      ownerUserId?: string;
      title?: string;
    }
  ): SessionRecord {
    return this.dependencies.sessionService.getOrCreateSession({
      agentProfileId: input?.agentProfileId ?? "executor",
      cwd: input?.cwd ?? this.dependencies.workspaceRoot,
      ownerUserId: input?.ownerUserId ?? process.env.USERNAME ?? process.env.USER ?? "local-user",
      providerName: this.dependencies.provider.name,
      sessionId,
      title: input?.title?.trim().length ? input.title : "Recovered session"
    });
  }

  public async continueSession(
    sessionId: string,
    input: string,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    this.ensureRuntimeSession(sessionId, {
      ...(overrides?.agentProfileId !== undefined ? { agentProfileId: overrides.agentProfileId } : {}),
      ...(overrides?.cwd !== undefined ? { cwd: overrides.cwd } : {}),
      ...(overrides?.userId !== undefined ? { ownerUserId: overrides.userId } : {}),
      title: input.slice(0, 80)
    });
    const options = this.dependencies.resumePacketBuilder.buildResumePacket(sessionId, input, overrides);
    return this.runTask(options);
  }

  public async continueLatest(
    input: string | undefined,
    overrides?: Partial<RuntimeRunOptions>
  ): Promise<RunTaskResult> {
    const ownerUserId = overrides?.userId ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
    const latest = this.dependencies.sessionService.findLatestSession(ownerUserId);
    if (latest === null) {
      throw new Error("No sessions found for current user.");
    }
    const resolvedInput =
      input ??
      this.dependencies.sessionCommitmentProjector.project(latest.sessionId).nextAction?.title ??
      null;
    if (resolvedInput === null) {
      throw new Error("No next action found for latest session. Provide an explicit task input.");
    }
    return this.continueSession(latest.sessionId, resolvedInput, overrides);
  }
}

