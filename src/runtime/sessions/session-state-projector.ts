import type {
  ConversationMessage,
  SessionCommitmentState,
  SessionMessageRepository,
  SessionSummaryRecord,
  SessionTranscriptRepository
} from "../../types/index.js";
import { selectTailMessages } from "../context/tail-selector.js";
import type { SessionSummaryService } from "../context/session-summary-service.js";
import type { SessionCommitmentProjector } from "../commitments/session-commitment-projector.js";
import { buildHygieneConversationMessages } from "./build-hygiene-conversation-messages.js";
import {
  formatFeatureBacklogForResume,
  parseFeatureBacklogFromMetadata
} from "./session-feature-backlog.js";
import { extractUserMessageText } from "./session-user-message-pin.js";

export interface SessionStateProjection {
  messages: ConversationMessage[];
  commitmentState: SessionCommitmentState;
  sessionSummary: SessionSummaryRecord | null;
}

export interface SessionStateProjectorDependencies {
  commitmentProjector: SessionCommitmentProjector;
  sessionMessageRepository: SessionMessageRepository;
  sessionSummaryService: SessionSummaryService;
  sessionTranscriptRepository: SessionTranscriptRepository;
  resumeUserTailMessages?: number;
  tailMinMessages?: number;
  tailTokenBudget?: number | null;
}

const DEFAULT_TAIL_MIN_MESSAGES = 6;
const DEFAULT_RESUME_USER_TAIL_MESSAGES = 6;

export class SessionStateProjector {
  public constructor(private readonly dependencies: SessionStateProjectorDependencies) {}

  public projectState(sessionId: string): SessionStateProjection {
    const commitmentState = this.dependencies.commitmentProjector.project(sessionId);
    const sessionSummary = this.dependencies.sessionSummaryService.findLatestBySession(sessionId);
    if (sessionSummary !== null) {
      const messages = [
        ...toResumeMessages(sessionSummary, commitmentState),
        ...projectUserTailMessages(sessionId, this.dependencies)
      ];
      return {
        commitmentState,
        messages,
        sessionSummary
      };
    }
    return {
      commitmentState,
      messages: projectFallbackResumeMessages(sessionId, commitmentState, this.dependencies),
      sessionSummary: null
    };
  }
}

function projectFallbackResumeMessages(
  sessionId: string,
  commitmentState: SessionCommitmentState,
  dependencies: SessionStateProjectorDependencies
): ConversationMessage[] {
  const messages = toCommitmentResumeMessages(commitmentState);
  const conversation = buildHygieneConversationMessages({
    sessionId,
    sessionMessageRepository: dependencies.sessionMessageRepository,
    sessionTranscriptRepository: dependencies.sessionTranscriptRepository
  });
  if (conversation.length === 0) {
    return messages;
  }
  const tail = selectTailMessages(conversation, {
    tailMinMessages: dependencies.tailMinMessages ?? DEFAULT_TAIL_MIN_MESSAGES,
    tailTokenBudget: dependencies.tailTokenBudget ?? null
  });
  return [...messages, ...tail.messages];
}

function projectUserTailMessages(
  sessionId: string,
  dependencies: SessionStateProjectorDependencies
): ConversationMessage[] {
  const limit = dependencies.resumeUserTailMessages ?? DEFAULT_RESUME_USER_TAIL_MESSAGES;
  const records = dependencies.sessionMessageRepository.listBySessionId(sessionId);
  const userMessages: ConversationMessage[] = [];
  for (const record of records) {
    const text = extractUserMessageText(record);
    if (text === null) {
      continue;
    }
    userMessages.push({ content: text, role: "user" });
  }
  if (userMessages.length === 0) {
    return [];
  }
  const tail = selectTailMessages(userMessages, {
    tailMinMessages: Math.min(limit, userMessages.length),
    tailTokenBudget: dependencies.tailTokenBudget ?? null
  });
  return tail.messages;
}

function toResumeMessages(
  sessionSummary: SessionSummaryRecord,
  commitmentState: SessionCommitmentState
): ConversationMessage[] {
  const messages: ConversationMessage[] = [
    {
      role: "system",
      content: `KnownActiveGoal: ${normalizeLine(sessionSummary.goal, 220)}`
    }
  ];
  const sessionTheme =
    typeof sessionSummary.metadata?.sessionTheme === "string"
      ? sessionSummary.metadata.sessionTheme.trim()
      : "";
  if (sessionTheme.length > 0) {
    messages.push({
      role: "system",
      content: `KnownSessionTheme: ${normalizeLine(sessionTheme, 220)}`
    });
  }
  const featureBacklog = formatFeatureBacklogForResume(
    parseFeatureBacklogFromMetadata(sessionSummary.metadata)
  );
  if (featureBacklog.length > 0) {
    messages.push({
      role: "system",
      content: `KnownFeatureBacklog:\n${featureBacklog}`
    });
  }
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
  return [...messages, ...toCommitmentResumeMessages(commitmentState)];
}

function toCommitmentResumeMessages(commitmentState: SessionCommitmentState): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
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
