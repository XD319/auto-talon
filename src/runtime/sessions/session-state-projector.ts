import type {
  ConversationMessage,
  SessionCommitmentState,
  SessionSummaryRecord
} from "../../types/index.js";
import type { SessionSummaryService } from "../context/session-summary-service.js";
import type { SessionCommitmentProjector } from "../commitments/session-commitment-projector.js";

export interface SessionStateProjection {
  messages: ConversationMessage[];
  commitmentState: SessionCommitmentState;
  sessionSummary: SessionSummaryRecord | null;
}

export interface SessionStateProjectorDependencies {
  sessionSummaryService: SessionSummaryService;
  commitmentProjector: SessionCommitmentProjector;
}

export class SessionStateProjector {
  public constructor(private readonly dependencies: SessionStateProjectorDependencies) {}

  public projectState(sessionId: string): SessionStateProjection {
    const commitmentState = this.dependencies.commitmentProjector.project(sessionId);
    const sessionSummary = this.dependencies.sessionSummaryService.findLatestBySession(sessionId);
    if (sessionSummary !== null) {
      const messages = toResumeMessages(sessionSummary, commitmentState);
      return {
        commitmentState,
        messages,
        sessionSummary
      };
    }
    return {
      commitmentState,
      messages: [],
      sessionSummary: null
    };
  }
}

function toResumeMessages(
  sessionSummary: SessionSummaryRecord,
  commitmentState: SessionCommitmentState
): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    {
      role: "system",
      content: `KnownSessionGoal: ${normalizeLine(sessionSummary.goal, 220)}`
    }
  ];
  const decisions = compactItems(sessionSummary.decisions, 3, 180);
  if (decisions.length > 0) {
    messages.push({
      role: "system",
      content: `KnownDecisions: ${decisions.join(" | ")}`
    });
  }
  const openLoops = compactItems(sessionSummary.openLoops, 3, 180);
  if (openLoops.length > 0) {
    messages.push({
      role: "system",
      content: `KnownOpenLoops: ${openLoops.join(" | ")}`
    });
  }
  const nextActions = compactItems(sessionSummary.nextActions, 3, 180);
  if (nextActions.length > 0) {
    messages.push({
      role: "system",
      content: `KnownNextActions: ${nextActions.join(" | ")}`
    });
  }
  if (commitmentState.currentObjective !== null) {
    messages.push({
      role: "system",
      content: `KnownCurrentObjective: ${normalizeLine(commitmentState.currentObjective.title, 180)}`
    });
  }
  if (commitmentState.nextAction !== null) {
    messages.push({
      role: "system",
      content: `KnownPlannedNextAction: ${normalizeLine(
        `${commitmentState.nextAction.title} (${commitmentState.nextAction.status})`,
        180
      )}`
    });
  }
  if (commitmentState.pendingDecision !== null) {
    messages.push({
      role: "system",
      content: `KnownPendingDecision: ${normalizeLine(commitmentState.pendingDecision, 180)}`
    });
  }
  return messages;
}

function compactItems(values: string[], limit: number, maxLength: number): string[] {
  const unique = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    const compact = normalizeLine(value, maxLength);
    if (compact.length === 0 || unique.has(compact)) {
      continue;
    }
    unique.add(compact);
    items.push(compact);
    if (items.length >= limit) {
      break;
    }
  }
  return items;
}

function normalizeLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) {
    return "";
  }
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

