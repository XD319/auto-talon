import { randomUUID } from "node:crypto";

import type { AppConfig } from "../bootstrap.js";
import type {
  ContextFragment,
  JsonObject,
  RuntimeRunOptions,
  SessionSummaryRecord,
  SessionTaskRepository,
  TaskRepository
} from "../../types/index.js";
import type { SessionStateProjector } from "./session-state-projector.js";
import { buildPriorTaskContextMessage } from "./prior-task-context.js";
import { similarText } from "./text-similarity.js";

export interface ResumePacketBuilderDependencies {
  stateProjector: SessionStateProjector;
  config: AppConfig;
  sessionTaskRepository?: SessionTaskRepository;
  taskRepository?: TaskRepository;
}

export class ResumePacketBuilder {
  public constructor(private readonly dependencies: ResumePacketBuilderDependencies) {}

  public buildResumePacket(
    sessionId: string,
    newInput: string,
    overrides?: Partial<RuntimeRunOptions>
  ): RuntimeRunOptions & { sessionId: string } {
    const projection = this.dependencies.stateProjector.projectState(sessionId);
    const contextMessages = [...projection.messages];
    const goalText = projection.sessionSummary?.goal ?? "";
    const intentChanged =
      newInput.trim().length > 0 && goalText.trim().length > 0 && !similarText(goalText, newInput);
    if (intentChanged) {
      contextMessages.push({
        role: "system",
        content: `KnownCurrentDirective: The user's NEW request supersedes earlier goals. Current task: ${normalizeSummary(newInput, 220)}`
      });
    }
    const priorTaskMessage = buildPriorTaskContextMessage({
      sessionId,
      tokenBudget: overrides?.tokenBudget ?? this.dependencies.config.tokenBudget,
      ...(this.dependencies.sessionTaskRepository !== undefined
        ? { sessionTaskRepository: this.dependencies.sessionTaskRepository }
        : {}),
      ...(this.dependencies.taskRepository !== undefined
        ? { taskRepository: this.dependencies.taskRepository }
        : {})
    });
    const priorTaskId =
      priorTaskMessage === null
        ? null
        : this.dependencies.sessionTaskRepository?.findLatestBySessionId(sessionId)?.taskId ?? null;
    if (priorTaskMessage !== null) {
      contextMessages.push(priorTaskMessage);
    }
    const metadata: JsonObject = {
      ...(overrides?.metadata ?? {}),
      sessionResume: {
        blockedReason: projection.commitmentState.blockedReason,
        commitments: projection.commitmentState.openCommitments,
        contextMessages,
        memoryContext: buildSessionResumeMemoryContext(projection.sessionSummary),
        nextAction: projection.commitmentState.nextAction,
        pendingDecision: projection.commitmentState.pendingDecision,
        priorTaskId,
        priorTaskOutputInjected: priorTaskMessage !== null,
        projectedMessageCount: contextMessages.length,
        sessionSummary: projection.sessionSummary
      } as unknown as JsonObject
    };
    return {
      agentProfileId: overrides?.agentProfileId ?? this.dependencies.config.defaultProfileId,
      cwd: overrides?.cwd ?? this.dependencies.config.workspaceRoot,
      maxIterations: overrides?.maxIterations ?? this.dependencies.config.defaultMaxIterations,
      metadata,
      ...(overrides?.onAssistantTextDelta !== undefined
        ? { onAssistantTextDelta: overrides.onAssistantTextDelta }
        : {}),
      ...(overrides?.onOutputEvent !== undefined ? { onOutputEvent: overrides.onOutputEvent } : {}),
      ...(overrides?.onTaskEvent !== undefined ? { onTaskEvent: overrides.onTaskEvent } : {}),
      ...(overrides?.signal !== undefined ? { signal: overrides.signal } : {}),
      taskInput: newInput,
      ...(overrides?.taskId !== undefined ? { taskId: overrides.taskId } : {}),
      sessionId,
      ...(overrides?.timeoutMode !== undefined ? { timeoutMode: overrides.timeoutMode } : {}),
      timeoutMs: overrides?.timeoutMs ?? this.dependencies.config.defaultTimeoutMs,
      tokenBudget: overrides?.tokenBudget ?? this.dependencies.config.tokenBudget,
      userId:
        overrides?.userId ?? process.env.USERNAME ?? process.env.USER ?? "local-user"
    };
  }
}

function buildSessionResumeMemoryContext(
  sessionSummary: SessionSummaryRecord | null
): ContextFragment[] {
  if (sessionSummary === null) {
    return [];
  }

  const fragments: ContextFragment[] = [];
  const trimmedGoal = normalizeSummary(sessionSummary.goal, 220);
  if (trimmedGoal.length > 0) {
    fragments.push(
      createResumeFragment("Active goal", "session_resume_goal", trimmedGoal, sessionSummary.createdAt)
    );
  }

  const decisions = dedupeCompact(sessionSummary.decisions, 3, 180);
  if (decisions.length > 0) {
    fragments.push(
      createResumeFragment(
        "Session decisions",
        "session_resume_decisions",
        decisions.join(" | "),
        sessionSummary.createdAt
      )
    );
  }

  const openLoops = dedupeCompact(sessionSummary.openLoops, 3, 180);
  if (openLoops.length > 0) {
    fragments.push(
      createResumeFragment(
        "Session open loops",
        "session_resume_open_loops",
        openLoops.join(" | "),
        sessionSummary.createdAt
      )
    );
  }

  const nextActions = dedupeCompact(sessionSummary.nextActions, 3, 180);
  if (nextActions.length > 0) {
    fragments.push(
      createResumeFragment(
        "Session next actions",
        "session_resume_next_actions",
        nextActions.join(" | "),
        sessionSummary.createdAt
      )
    );
  }

  return fragments;
}

function createResumeFragment(
  title: string,
  memoryIdSuffix: string,
  text: string,
  createdAt: string
): ContextFragment {
  void createdAt;
  return {
    confidence: 0.97,
    explanation: "session resume packet fragment",
    fragmentId: randomUUID(),
    memoryId: `session_resume:${memoryIdSuffix}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Session resume context is injected only for active continuation runs.",
      ttlDays: null
    },
    scope: "working",
    sourceType: "system",
    status: "verified",
    text,
    title
  };
}

function dedupeCompact(values: string[], limit: number, maxLength: number): string[] {
  const unique = new Set<string>();
  const compacted: string[] = [];
  for (const value of values) {
    const normalized = normalizeSummary(value, maxLength);
    if (normalized.length === 0 || unique.has(normalized)) {
      continue;
    }
    unique.add(normalized);
    compacted.push(normalized);
    if (compacted.length >= limit) {
      break;
    }
  }
  return compacted;
}

function normalizeSummary(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}
