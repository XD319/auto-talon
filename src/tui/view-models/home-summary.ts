import type { TuiRuntimeService } from "../runtime-api.js";
import type { InboxItem, SessionRecord } from "../../types/index.js";
import { buildTodaySummary, type TodaySummaryViewModel } from "./today-summary.js";

export interface HomeSummaryAction {
  detail: string;
  inboxId?: string;
  key: string;
  label: string;
  sessionId?: string | null;
}

export interface HomeSummarySessionCard {
  detail: string;
  headline: string;
  label: string;
  sessionId: string;
}

export interface HomeSummaryEntry {
  detail: string;
  headline?: string;
  inboxId?: string;
  key: string;
  kind: "action" | "session";
  label: string;
  sessionId?: string | null;
}

export interface HomeSummaryViewModel {
  actions: HomeSummaryAction[];
  agenda: string[];
  assistantHint: string;
  recentSessions: HomeSummarySessionCard[];
  recommendedSession: HomeSummarySessionCard | null;
  title: string;
}

const MAX_AGENDA_ITEMS = 3;
const MAX_HOME_ENTRIES = 4;
const MAX_SESSION_CARDS = 3;
const AGENDA_LABEL_LENGTH = 72;
const ENTRY_LABEL_LENGTH = 76;
const ENTRY_DETAIL_LENGTH = 92;
const SESSION_HEADLINE_LENGTH = 72;

export function buildHomeSummary(
  service: Pick<
    TuiRuntimeService,
    | "listCommitments"
    | "listInbox"
    | "listNextActions"
    | "listPendingApprovals"
    | "listSchedules"
    | "listSessions"
    | "showTask"
    | "showSession"
  >,
  options: { activeSessionId?: string | null } = {}
): HomeSummaryViewModel {
  const summary = buildTodaySummary(service as TuiRuntimeService, options);
  const actionableInboxItem = findActionableInboxItem(service, summary.userId);
  const recentSessions = buildRecentSessionCards(service, summary);
  const recommendedSession = buildRecommendedSessionCard(service, summary, recentSessions, actionableInboxItem);
  const actions = buildRecommendedActions(service, summary, actionableInboxItem);
  const primaryEntry = listHomeSummaryEntries({
    actions,
    agenda: [],
    assistantHint: "",
    recentSessions,
    recommendedSession,
    title: ""
  })[0] ?? null;

  return {
    actions,
    agenda: buildAgenda(service, summary, recommendedSession),
    assistantHint: primaryEntry !== null ? "Type a request below, or use Up/Down and Enter to open a next step." : "",
    recentSessions,
    recommendedSession,
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
      ...(action.inboxId !== undefined ? { inboxId: action.inboxId } : {}),
      ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {})
    });
  }
  for (const session of prioritizeRecommendedSession(summary.recentSessions, summary.recommendedSession)) {
    if (entries.length >= MAX_HOME_ENTRIES) {
      break;
    }
    const sessionLabel = summarizeText(session.headline.length > 0 ? session.headline : session.label, ENTRY_LABEL_LENGTH);
    entries.push({
      detail: session.detail,
      key: `session:${session.sessionId}`,
      kind: "session",
      label: `Continue ${sessionLabel}`,
      sessionId: session.sessionId
    });
  }
  return entries;
}

function buildAgenda(
  service: Pick<TuiRuntimeService, "showSession">,
  summary: TodaySummaryViewModel,
  recommendedSession: HomeSummarySessionCard | null
): string[] {
  const agenda: string[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    agenda.push(compactAgendaLine(`Approval needed: ${approval.toolName}`));
  }
  const overdueRoutine = summary.dueRoutines.items[0];
  if (overdueRoutine !== undefined) {
    agenda.push(compactAgendaLine(`Routine ready: ${overdueRoutine.name}`));
  }
  const nextAction = summary.nextActions.items[0];
  if (agenda.length < 3 && nextAction !== undefined) {
    agenda.push(compactAgendaLine(`Continue: ${formatNextActionAgendaLabel(service, nextAction)}`));
  }
  if (agenda.length === 0 && recommendedSession !== null) {
    agenda.push(compactAgendaLine(`Continue: ${recommendedSession.label}`));
  }
  return agenda.slice(0, MAX_AGENDA_ITEMS);
}

function buildRecommendedActions(
  service: Pick<TuiRuntimeService, "showTask" | "showSession">,
  summary: TodaySummaryViewModel,
  actionableInboxItem: InboxItem | null
): HomeSummaryAction[] {
  const actions: HomeSummaryAction[] = [];
  const approval = summary.pendingApprovals.items[0];
  if (approval !== undefined) {
    actions.push({
      detail: `Resolve ${approval.toolName} before it expires.`,
      key: "approval",
      label: "Respond to approval",
      sessionId: service.showTask(approval.taskId).task?.sessionId ?? null
    });
  }
  const inboxItem = actionableInboxItem;
  if (inboxItem !== null) {
    const inboxLabel = formatInboxDisplayLabel(service, inboxItem);
    actions.push({
      detail: formatInboxDetail(inboxItem),
      inboxId: inboxItem.inboxId,
      key: "inbox",
      label: `Open inbox: ${inboxLabel}`,
      sessionId: inboxItem.sessionId
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
  if (actions.length === 0) {
    actions.push({
      detail: "Describe what you want AutoTalon to do in the prompt below.",
      key: "start",
      label: "Start a task"
    });
  }
  return actions.slice(0, MAX_HOME_ENTRIES);
}

function buildRecentSessionCards(
  service: Pick<TuiRuntimeService, "showSession">,
  summary: TodaySummaryViewModel
): HomeSummarySessionCard[] {
  return dedupeSessionCards(summary.sessions.items.map((session) => buildSessionCard(service, session))).slice(0, MAX_SESSION_CARDS);
}

function buildRecommendedSessionCard(
  service: Pick<TuiRuntimeService, "showSession">,
  summary: TodaySummaryViewModel,
  recentSessions: HomeSummarySessionCard[],
  actionableInboxItem: InboxItem | null
): HomeSummarySessionCard | null {
  const recommendedSessionId =
    summary.nextActions.items[0]?.sessionId ??
    summary.commitments.items[0]?.sessionId ??
    actionableInboxItem?.sessionId ??
    recentSessions[0]?.sessionId ??
    null;

  if (recommendedSessionId === null) {
    return null;
  }
  return (
    recentSessions.find((session) => session.sessionId === recommendedSessionId) ??
    buildSessionCardById(service, recommendedSessionId)
  );
}

function buildSessionCardById(
  service: Pick<TuiRuntimeService, "showSession">,
  sessionId: string
): HomeSummarySessionCard | null {
  const detail = service.showSession(sessionId);
  if (detail.session === null) {
    return null;
  }
  return buildSessionCard(service, detail.session);
}

function prioritizeRecommendedSession(
  recentSessions: HomeSummarySessionCard[],
  recommendedSession: HomeSummarySessionCard | null
): HomeSummarySessionCard[] {
  if (recommendedSession === null) {
    return recentSessions;
  }
  return dedupeSessionCards([
    recommendedSession,
    ...recentSessions.filter((session) => session.sessionId !== recommendedSession.sessionId)
  ]);
}

function buildSessionCard(
  service: Pick<TuiRuntimeService, "showSession">,
  session: SessionRecord
): HomeSummarySessionCard {
  const detail = service.showSession(session.sessionId);
  const headline =
    detail.state.currentObjective?.title ??
    detail.state.nextAction?.title ??
    detail.inboxItems.find(isUsefulSessionCardInboxItem)?.title ??
    session.title;
  const latestRun = detail.tasks.at(-1);
  const suffix =
    detail.state.blockedReason ??
    detail.state.pendingDecision ??
    detail.state.nextAction?.title ??
    (latestRun !== undefined ? `recent run ${latestRun.status}` : "ready to continue");

  return {
    detail: summarizeText(humanizeRuntimeSummary(suffix), ENTRY_DETAIL_LENGTH),
    headline: summarizeText(headline, SESSION_HEADLINE_LENGTH),
    label: summarizeText(session.title, ENTRY_LABEL_LENGTH),
    sessionId: session.sessionId
  };
}

function dedupeSessionCards(cards: HomeSummarySessionCard[]): HomeSummarySessionCard[] {
  const seen = new Set<string>();
  const deduped: HomeSummarySessionCard[] = [];
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

function findActionableInboxItem(
  service: Pick<TuiRuntimeService, "listInbox">,
  userId: string
): InboxItem | null {
  return (
    service
      .listInbox({ status: "pending", userId })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .find(isActionableInboxItem) ?? null
  );
}

function isUsefulSessionCardInboxItem(item: InboxItem): boolean {
  return isActionableInboxItem(item);
}

function formatInboxDisplayLabel(
  service: Pick<TuiRuntimeService, "showSession">,
  item: InboxItem
): string {
  const subject = isGenericInboxTitle(item.title) ? "" : item.title;
  const sessionTitle = item.sessionId === null ? null : service.showSession(item.sessionId).session?.title ?? null;
  if (sessionTitle === null || sessionTitle.length === 0) {
    return subject.length > 0 ? subject : summarizeText(humanizeRuntimeSummary(item.summary), ENTRY_LABEL_LENGTH);
  }
  if (subject.length === 0 || subject === sessionTitle) {
    return summarizeText(sessionTitle, ENTRY_LABEL_LENGTH);
  }
  return summarizeText(`${sessionTitle} - ${subject}`, ENTRY_LABEL_LENGTH);
}

function formatNextActionAgendaLabel(
  service: Pick<TuiRuntimeService, "showSession">,
  nextAction: TodaySummaryViewModel["nextActions"]["items"][number]
): string {
  if (!looksLikeAssistantNarrative(nextAction.title)) {
    return nextAction.title;
  }
  const detail = service.showSession(nextAction.sessionId);
  return (
    firstUsefulText([
      detail.state.currentObjective?.title,
      detail.session?.title,
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
