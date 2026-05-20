import type { TuiRuntimeService } from "../runtime-api.js";
import type { InboxItem, ThreadRecord } from "../../types/index.js";
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

const MAX_AGENDA_ITEMS = 3;
const MAX_HOME_ENTRIES = 4;
const MAX_THREAD_CARDS = 3;
const AGENDA_LABEL_LENGTH = 72;
const ENTRY_LABEL_LENGTH = 76;
const ENTRY_DETAIL_LENGTH = 92;
const THREAD_HEADLINE_LENGTH = 72;

export function buildHomeSummary(
  service: Pick<
    TuiRuntimeService,
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
  const summary = buildTodaySummary(service as TuiRuntimeService, options);
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
    agenda: buildAgenda(service, summary, recommendedThread),
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
    if (entries.length >= MAX_HOME_ENTRIES) {
      break;
    }
    const threadLabel = summarizeText(thread.headline.length > 0 ? thread.headline : thread.label, ENTRY_LABEL_LENGTH);
    entries.push({
      detail: thread.detail,
      key: `thread:${thread.threadId}`,
      kind: "thread",
      label: `Continue ${threadLabel}`,
      threadId: thread.threadId
    });
  }
  return entries;
}

function buildAgenda(
  service: Pick<TuiRuntimeService, "showThread">,
  summary: TodaySummaryViewModel,
  recommendedThread: HomeSummaryThreadCard | null
): string[] {
  const agenda: string[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    agenda.push(compactAgendaLine(`Approval needed: ${approval.toolName}`));
  }
  const actionableInboxItem = summary.inbox.items.find(isActionableInboxItem);
  if (actionableInboxItem !== undefined) {
    agenda.push(compactAgendaLine(`Review: ${formatInboxDisplayLabel(service, actionableInboxItem)}`));
  }
  const overdueRoutine = summary.dueRoutines.items[0];
  if (overdueRoutine !== undefined) {
    agenda.push(compactAgendaLine(`Routine ready: ${overdueRoutine.name}`));
  }
  const nextAction = summary.nextActions.items[0];
  if (agenda.length < 3 && nextAction !== undefined) {
    agenda.push(compactAgendaLine(`Continue: ${formatNextActionAgendaLabel(service, nextAction)}`));
  }
  if (agenda.length === 0 && recommendedThread !== null) {
    agenda.push(compactAgendaLine(`Continue: ${recommendedThread.label}`));
  }
  return agenda.slice(0, MAX_AGENDA_ITEMS);
}

function buildRecommendedActions(
  service: Pick<TuiRuntimeService, "showTask" | "showThread">,
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
  const inboxItem = summary.inbox.items.find(isActionableInboxItem);
  if (inboxItem !== undefined) {
    const inboxLabel = formatInboxDisplayLabel(service, inboxItem);
    actions.push({
      detail: formatInboxDetail(inboxItem),
      key: "inbox",
      label: `Open inbox: ${inboxLabel}`,
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
  return actions.slice(0, MAX_HOME_ENTRIES);
}

function buildRecentThreadCards(
  service: Pick<TuiRuntimeService, "showThread">,
  summary: TodaySummaryViewModel
): HomeSummaryThreadCard[] {
  return dedupeThreadCards(summary.threads.items.map((thread) => buildThreadCard(service, thread))).slice(0, MAX_THREAD_CARDS);
}

function buildRecommendedThreadCard(
  service: Pick<TuiRuntimeService, "showThread">,
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
  service: Pick<TuiRuntimeService, "showThread">,
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
  return dedupeThreadCards([
    recommendedThread,
    ...recentThreads.filter((thread) => thread.threadId !== recommendedThread.threadId)
  ]);
}

function buildThreadCard(
  service: Pick<TuiRuntimeService, "showThread">,
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
    detail: summarizeText(humanizeRuntimeSummary(suffix), ENTRY_DETAIL_LENGTH),
    headline: summarizeText(headline, THREAD_HEADLINE_LENGTH),
    label: summarizeText(thread.title, ENTRY_LABEL_LENGTH),
    threadId: thread.threadId
  };
}

function dedupeThreadCards(cards: HomeSummaryThreadCard[]): HomeSummaryThreadCard[] {
  const seen = new Set<string>();
  const deduped: HomeSummaryThreadCard[] = [];
  for (const card of cards) {
    const key = normalizeDedupeText(card.label);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(card);
  }
  return deduped;
}

function isActionableInboxItem(item: InboxItem): boolean {
  return item.severity === "action_required" || item.severity === "warning" || item.category !== "task_completed";
}

function formatInboxDisplayLabel(
  service: Pick<TuiRuntimeService, "showThread">,
  item: InboxItem
): string {
  const subject = isGenericInboxTitle(item.title) ? "" : item.title;
  const threadTitle = item.threadId === null ? null : service.showThread(item.threadId).thread?.title ?? null;
  if (threadTitle === null || threadTitle.length === 0) {
    return subject.length > 0 ? subject : summarizeText(humanizeRuntimeSummary(item.summary), ENTRY_LABEL_LENGTH);
  }
  if (subject.length === 0 || subject === threadTitle) {
    return summarizeText(threadTitle, ENTRY_LABEL_LENGTH);
  }
  return summarizeText(`${threadTitle} - ${subject}`, ENTRY_LABEL_LENGTH);
}

function formatNextActionAgendaLabel(
  service: Pick<TuiRuntimeService, "showThread">,
  nextAction: TodaySummaryViewModel["nextActions"]["items"][number]
): string {
  if (!looksLikeAssistantNarrative(nextAction.title)) {
    return nextAction.title;
  }
  const detail = service.showThread(nextAction.threadId);
  return (
    firstUsefulText([
      detail.state.currentObjective?.title,
      detail.thread?.title,
      nextAction.title
    ]) ?? nextAction.title
  );
}

function formatInboxDetail(item: InboxItem): string {
  const summary = summarizeText(humanizeRuntimeSummary(item.summary), ENTRY_DETAIL_LENGTH);
  const prefix = formatInboxCategoryLabel(item);
  return summary.length > 0 ? `${prefix}: ${summary}` : prefix;
}

function formatInboxCategoryLabel(item: InboxItem): string {
  switch (item.category) {
    case "approval_requested":
      return "Approval needed";
    case "budget_exceeded":
      return "Budget exceeded";
    case "budget_warning":
      return "Budget warning";
    case "decision_requested":
      return "Decision needed";
    case "memory_suggestion":
      return "Memory suggestion";
    case "skill_promotion":
      return "Skill suggestion";
    case "task_blocked":
      return "Blocked";
    case "task_failed":
      return "Failed";
    default:
      return "Inbox";
  }
}

function isGenericInboxTitle(title: string): boolean {
  return title === "Task completed" || title === "Task failed" || title === "Task blocked" || title === "Next action blocked";
}

function firstUsefulText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return null;
}

function looksLikeAssistantNarrative(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length > 120) {
    return true;
  }
  return normalized.includes("\u6211\u5df2\u7ecf") || normalized.includes("\u8ba9\u6211") || normalized.includes("**");
}

function summarizeText(value: string, maxLength = 72): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function compactAgendaLine(value: string): string {
  return summarizeText(humanizeRuntimeSummary(value), AGENDA_LABEL_LENGTH);
}

function humanizeRuntimeSummary(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const lower = normalized.toLowerCase();
  if (lower.includes("eisdir") || lower.includes("illegal operation on a directory")) {
    return "A directory was used where a file path was expected.";
  }
  if (lower.includes("provider_error") || lower.includes("xunfei") || lower.includes("engineinter")) {
    return "Provider returned an error while handling this task.";
  }
  if (lower.startsWith("provider error")) {
    return "Provider returned an error while handling this task.";
  }
  return normalized;
}

function normalizeDedupeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}
