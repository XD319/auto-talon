import type { AgentApplicationService } from "../../runtime/index.js";
import type { ThreadRecord } from "../../types/index.js";
import { buildTodaySummary, type TodaySummaryViewModel } from "./today-summary.js";

export interface HomeSummaryAction {
  detail: string;
  key: string;
  label: string;
  threadId?: string | null;
}

export interface HomeSummaryThreadCard {
  detail: string;
  headline: string;
  label: string;
  threadId: string;
}

export interface HomeSummaryEntry {
  detail: string;
  headline?: string;
  key: string;
  kind: "action" | "thread";
  label: string;
  threadId?: string | null;
}

export interface HomeSummaryViewModel {
  actions: HomeSummaryAction[];
  agenda: string[];
  assistantHint: string;
  recentThreads: HomeSummaryThreadCard[];
  recommendedThread: HomeSummaryThreadCard | null;
  title: string;
}

export function buildHomeSummary(
  service: Pick<
    AgentApplicationService,
    | "listCommitments"
    | "listInbox"
    | "listNextActions"
    | "listPendingApprovals"
    | "listSchedules"
    | "listThreads"
    | "showTask"
    | "showThread"
  >,
  options: { activeThreadId?: string | null } = {}
): HomeSummaryViewModel {
  const summary = buildTodaySummary(service as AgentApplicationService, options);
  const recentThreads = buildRecentThreadCards(service, summary);
  const recommendedThread = buildRecommendedThreadCard(service, summary, recentThreads);
  const actions = buildRecommendedActions(service, summary);
  const primaryEntry = listHomeSummaryEntries({
    actions,
    agenda: [],
    assistantHint: "",
    recentThreads,
    recommendedThread,
    title: ""
  })[0] ?? null;

  return {
    actions,
    agenda: buildAgenda(summary, recommendedThread),
    assistantHint: primaryEntry !== null ? "Use Up/Down and Enter to open an item." : "",
    recentThreads,
    recommendedThread,
    title: ""
  };
}

export function listHomeSummaryEntries(summary: HomeSummaryViewModel): HomeSummaryEntry[] {
  const entries: HomeSummaryEntry[] = [];
  for (const action of summary.actions) {
    entries.push({
      detail: action.detail,
      key: action.key,
      kind: "action",
      label: action.label,
      ...(action.threadId !== undefined ? { threadId: action.threadId } : {})
    });
  }
  for (const thread of prioritizeRecommendedThread(summary.recentThreads, summary.recommendedThread)) {
    entries.push({
      detail: thread.detail,
      ...(thread.headline !== thread.label ? { headline: thread.headline } : {}),
      key: `thread:${thread.threadId}`,
      kind: "thread",
      label: `Continue ${thread.label}`,
      threadId: thread.threadId
    });
  }
  return entries;
}

function buildAgenda(
  summary: TodaySummaryViewModel,
  recommendedThread: HomeSummaryThreadCard | null
): string[] {
  const agenda: string[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    agenda.push(`Approval needed: ${approval.toolName}`);
  }
  const inboxItem = summary.inbox.items[0];
  if (inboxItem !== undefined) {
    agenda.push(`Review waiting: ${inboxItem.title}`);
  }
  const overdueRoutine = summary.dueRoutines.items[0];
  if (overdueRoutine !== undefined) {
    agenda.push(`Routine ready: ${overdueRoutine.name}`);
  }
  const nextAction = summary.nextActions.items[0];
  if (agenda.length < 3 && nextAction !== undefined) {
    agenda.push(`Continue: ${nextAction.title}`);
  }
  if (agenda.length === 0 && recommendedThread !== null) {
    agenda.push(recommendedThread.detail);
  }
  return agenda.slice(0, 3);
}

function buildRecommendedActions(
  service: Pick<AgentApplicationService, "showTask">,
  summary: TodaySummaryViewModel
): HomeSummaryAction[] {
  const actions: HomeSummaryAction[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    actions.push({
      detail: `Resolve ${approval.toolName} before it expires.`,
      key: "approval",
      label: "Respond to approval",
      threadId: service.showTask(approval.taskId).task?.threadId ?? null
    });
  }
  const inboxItem = summary.inbox.items[0];
  if (inboxItem !== undefined) {
    actions.push({
      detail: `Open ${inboxItem.title}.`,
      key: "inbox",
      label: "Open inbox item",
      threadId: inboxItem.threadId
    });
  }
  const routine = summary.dueRoutines.items[0];
  if (routine !== undefined) {
    actions.push({
      detail: `Run or inspect ${routine.name}.`,
      key: "routine",
      label: "Open routine"
    });
  }
  return actions.slice(0, 3);
}

function buildRecentThreadCards(
  service: Pick<AgentApplicationService, "showThread">,
  summary: TodaySummaryViewModel
): HomeSummaryThreadCard[] {
  return summary.threads.items.slice(0, 3).map((thread) => buildThreadCard(service, thread));
}

function buildRecommendedThreadCard(
  service: Pick<AgentApplicationService, "showThread">,
  summary: TodaySummaryViewModel,
  recentThreads: HomeSummaryThreadCard[]
): HomeSummaryThreadCard | null {
  const recommendedThreadId =
    summary.nextActions.items[0]?.threadId ??
    summary.commitments.items[0]?.threadId ??
    summary.inbox.items[0]?.threadId ??
    recentThreads[0]?.threadId ??
    null;

  if (recommendedThreadId === null) {
    return null;
  }
  return (
    recentThreads.find((thread) => thread.threadId === recommendedThreadId) ??
    buildThreadCardById(service, recommendedThreadId)
  );
}

function buildThreadCardById(
  service: Pick<AgentApplicationService, "showThread">,
  threadId: string
): HomeSummaryThreadCard | null {
  const detail = service.showThread(threadId);
  if (detail.thread === null) {
    return null;
  }
  return buildThreadCard(service, detail.thread);
}

function prioritizeRecommendedThread(
  recentThreads: HomeSummaryThreadCard[],
  recommendedThread: HomeSummaryThreadCard | null
): HomeSummaryThreadCard[] {
  if (recommendedThread === null) {
    return recentThreads;
  }
  return [
    recommendedThread,
    ...recentThreads.filter((thread) => thread.threadId !== recommendedThread.threadId)
  ];
}

function buildThreadCard(
  service: Pick<AgentApplicationService, "showThread">,
  thread: ThreadRecord
): HomeSummaryThreadCard {
  const detail = service.showThread(thread.threadId);
  const headline =
    detail.state.currentObjective?.title ??
    detail.state.nextAction?.title ??
    detail.inboxItems[0]?.title ??
    thread.title;
  const suffix =
    detail.state.blockedReason ??
    detail.state.pendingDecision ??
    detail.state.nextAction?.title ??
    (detail.runs[0]?.status !== undefined ? `recent run ${detail.runs[0].status}` : "ready to continue");

  return {
    detail: suffix,
    headline,
    label: thread.title,
    threadId: thread.threadId
  };
}
