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
  const recommendedThread = recentThreads[0] ?? null;
  const actions = buildRecommendedActions(service, summary, recommendedThread);
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
    assistantHint:
      primaryEntry !== null
        ? `Use Up/Down to choose ${primaryEntry.label.toLowerCase()}, press Enter to open it, or type a request in plain language.`
        : "Type a request in plain language to start a new thread.",
    recentThreads,
    recommendedThread,
    title: "Today at a glance"
  };
}

export function listHomeSummaryEntries(summary: HomeSummaryViewModel): HomeSummaryEntry[] {
  const entries: HomeSummaryEntry[] = [];
  for (const thread of summary.recentThreads) {
    entries.push({
      detail: thread.detail,
      headline: thread.headline,
      key: `thread:${thread.threadId}`,
      kind: "thread",
      label: thread.label,
      threadId: thread.threadId
    });
  }
  for (const action of summary.actions) {
    entries.push({
      detail: action.detail,
      key: action.key,
      kind: "action",
      label: action.label,
      ...(action.threadId !== undefined ? { threadId: action.threadId } : {})
    });
  }
  return entries;
}

function buildAgenda(
  summary: TodaySummaryViewModel,
  recommendedThread: HomeSummaryThreadCard | null
): string[] {
  const agenda: string[] = [];
  const overdueRoutine = summary.dueRoutines.items[0];
  if (overdueRoutine !== undefined) {
    agenda.push(`Routine due: ${overdueRoutine.name}`);
  }
  const inboxItem = summary.inbox.items[0];
  if (inboxItem !== undefined) {
    agenda.push(`Inbox waiting: ${inboxItem.title}`);
  }
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    agenda.push(`Decision needed: ${approval.toolName}`);
  }
  if (agenda.length === 0 && recommendedThread !== null) {
    agenda.push(recommendedThread.detail);
  }
  if (agenda.length === 0) {
    agenda.push("No urgent items. You can start a new task or continue from history.");
  }
  return agenda.slice(0, 3);
}

function buildRecommendedActions(
  service: Pick<AgentApplicationService, "showTask">,
  summary: TodaySummaryViewModel,
  recommendedThread: HomeSummaryThreadCard | null
): HomeSummaryAction[] {
  const actions: HomeSummaryAction[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    actions.push({
      detail: `Resolve ${approval.toolName} before it expires.`,
      key: "approval",
      label: "Review pending approval",
      threadId: service.showTask(approval.taskId).task?.threadId ?? null
    });
  }
  const inboxItem = summary.inbox.items[0];
  if (inboxItem !== undefined) {
    actions.push({
      detail: `Open ${inboxItem.title}.`,
      key: "inbox",
      label: "Triage inbox",
      threadId: inboxItem.threadId
    });
  }
  const routine = summary.dueRoutines.items[0];
  if (routine !== undefined) {
    actions.push({
      detail: `Run or inspect ${routine.name}.`,
      key: "routine",
      label: "Check due routine"
    });
  }
  if (actions.length === 0 && recommendedThread === null) {
    actions.push({
      detail: "Start with a plain-language goal or ask for today's plan.",
      key: "start",
      label: "Start a new task"
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
