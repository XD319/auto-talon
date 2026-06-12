import type {
  CommitmentRecord,
  NextActionRecord,
  SessionCommitmentState
} from "../../types/index.js";

import type { CommitmentService } from "./commitment-service.js";
import type { NextActionService } from "./next-action-service.js";
import type { SessionSummaryService } from "../context/session-summary-service.js";

export interface SessionCommitmentProjectorDependencies {
  commitmentService: CommitmentService;
  nextActionService: NextActionService;
  sessionSummaryService: SessionSummaryService;
}

export class SessionCommitmentProjector {
  public constructor(private readonly dependencies: SessionCommitmentProjectorDependencies) {}

  public project(sessionId: string): SessionCommitmentState {
    const commitments = this.dependencies.commitmentService.list({
      statuses: ["open", "in_progress", "blocked", "waiting_decision"],
      sessionId
    });
    const nextActions = this.dependencies.nextActionService.list({
      statuses: ["active", "blocked", "pending"],
      sessionId
    });
    const latestSessionSummary = this.dependencies.sessionSummaryService.findLatestBySession(sessionId);
    const currentObjective = pickCurrentObjective(commitments);
    const nextAction = pickNextAction(nextActions);
    const blockedNextAction = nextActions.find((item) => item.status === "blocked" && item.blockedReason !== null);
    return {
      activeNextActions: nextActions,
      blockedReason:
        blockedNextAction?.blockedReason ??
        nextAction?.blockedReason ??
        currentObjective?.blockedReason ??
        latestSessionSummary?.openLoops[0] ??
        null,
      currentObjective,
      nextAction,
      openCommitments: commitments,
      pendingDecision: currentObjective?.pendingDecision ?? latestSessionSummary?.decisions[0] ?? null
    };
  }
}

function pickCurrentObjective(items: CommitmentRecord[]): CommitmentRecord | null {
  return items.find((item) => item.status === "in_progress") ?? items[0] ?? null;
}

function pickNextAction(items: NextActionRecord[]): NextActionRecord | null {
  return items.find((item) => item.status === "active") ?? items[0] ?? null;
}
