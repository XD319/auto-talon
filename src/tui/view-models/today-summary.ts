import type { TuiRuntimeService } from "../runtime-api.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ScheduleRecord,
  ThreadRunRecord,
  ThreadRecord
} from "../../types/index.js";

export interface TodaySummarySection<TItem> {
  items: TItem[];
  total: number;
}

export interface TodaySummaryViewModel {
  commitments: TodaySummarySection<CommitmentRecord>;
  dueRoutines: TodaySummarySection<ScheduleRecord>;
  inbox: TodaySummarySection<InboxItem>;
  nextActions: TodaySummarySection<NextActionRecord>;
  pendingApprovals: TodaySummarySection<ApprovalRecord>;
  threads: TodaySummarySection<ThreadRecord>;
  userId: string;
}

export interface BuildTodaySummaryOptions {
  activeThreadId?: string | null;
  limit?: number;
}

const DEFAULT_LIMIT = 5;

export function resolveRuntimeUserId(): string {
  return process.env.USERNAME ?? process.env.USER ?? "local-user";
}

export function buildTodaySummary(
  service: TuiRuntimeService,
  options: BuildTodaySummaryOptions = {}
): TodaySummaryViewModel {
  const userId = resolveRuntimeUserId();
  const activeThreadId = options.activeThreadId ?? null;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const threadsAll = service
    .listThreads("active")
    .filter((item) => item.ownerUserId === userId)
    .sort((left, right) => byIsoDesc(left.updatedAt, right.updatedAt));
  const threadIds = new Set(threadsAll.map((item) => item.threadId));

  const inboxAll = service
    .listInbox({ status: "pending", userId })
    .sort((left, right) => byIsoDesc(left.updatedAt, right.updatedAt));

  const commitmentsAll = service
    .listCommitments({
      ownerUserId: userId,
      statuses: ["open", "in_progress", "blocked", "waiting_decision"]
    })
    .sort((left, right) => byIsoDesc(left.updatedAt, right.updatedAt));

  const nextActionsAll = service
    .listNextActions({ statuses: ["active", "pending"] })
    .filter((item) => threadIds.has(item.threadId))
    .sort((left, right) => compareNextAction(left, right, activeThreadId));

  const pendingApprovalsAll = service
    .listPendingApprovals()
    .sort((left, right) => byIsoAsc(left.expiresAt, right.expiresAt));
  const dueRoutinesAll = service
    .listSchedules({ ownerUserId: userId, status: "active" })
    .filter((item) => isDueTodayOrOverdue(item, new Date()))
    .sort(compareDueRoutine);

  return {
    commitments: { items: prioritizeByThread(commitmentsAll, activeThreadId).slice(0, limit), total: commitmentsAll.length },
    dueRoutines: { items: dueRoutinesAll.slice(0, limit), total: dueRoutinesAll.length },
    inbox: { items: inboxAll.slice(0, limit), total: inboxAll.length },
    nextActions: { items: nextActionsAll.slice(0, limit), total: nextActionsAll.length },
    pendingApprovals: { items: pendingApprovalsAll.slice(0, limit), total: pendingApprovalsAll.length },
    threads: { items: prioritizeByThread(threadsAll, activeThreadId).slice(0, limit), total: threadsAll.length },
    userId
  };
}

export function formatTodaySummary(summary: TodaySummaryViewModel): string {
  return [
    `Today summary (user=${summary.userId})`,
    formatSection(
      "Due Routines",
      summary.dueRoutines.total,
      summary.dueRoutines.items,
      (item) => `${item.scheduleId.slice(0, 8)} | ${item.name} [${formatRoutineStatus(item)}]`
    ),
    formatSection(
      "Inbox",
      summary.inbox.total,
      summary.inbox.items,
      (item) => `${item.inboxId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Threads",
      summary.threads.total,
      summary.threads.items,
      (item) => `${item.threadId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Commitments",
      summary.commitments.total,
      summary.commitments.items,
      (item) => `${item.commitmentId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Next Actions",
      summary.nextActions.total,
      summary.nextActions.items,
      (item) => `${item.nextActionId.slice(0, 8)} | ${item.title} [${item.status}]`
    ),
    formatSection(
      "Pending Approvals",
      summary.pendingApprovals.total,
      summary.pendingApprovals.items,
      (item) => `${item.approvalId.slice(0, 8)} | ${item.toolName} (expires ${item.expiresAt})`
    )
  ].join("\n");
}

export function formatThreadDetailForTui(
  service: TuiRuntimeService,
  threadId: string
): string {
  const detail = service.showThread(threadId);
  if (detail.thread === null) {
    return `Thread ${threadId} not found.`;
  }
  const recentRuns = [...detail.runs].sort((left, right) => byIsoDesc(left.createdAt, right.createdAt)).slice(0, 3);
  const recentScheduleRuns = [...detail.scheduleRuns]
    .sort((left, right) => byIsoDesc(left.scheduledAt, right.scheduledAt))
    .slice(0, 2);
  const recentInboxItems = detail.inboxItems.filter(isUsefulThreadInboxItem).slice(0, 2);
  const lines = [
    `Thread ${detail.thread.threadId} | ${detail.thread.title}`,
    `status=${detail.thread.status} updatedAt=${detail.thread.updatedAt}`,
    `counts: runs=${detail.runs.length} commitments=${detail.commitments.length} next_actions=${detail.nextActions.length} inbox=${detail.inboxItems.length} schedules=${detail.scheduleRuns.length}`
  ];
  if (detail.state.currentObjective !== null) {
    lines.push(`objective: ${detail.state.currentObjective.title} [${detail.state.currentObjective.status}]`);
  }
  if (detail.state.nextAction !== null) {
    lines.push(`next: ${detail.state.nextAction.title} [${detail.state.nextAction.status}]`);
  }
  if (detail.state.blockedReason !== null) {
    lines.push(`blocked: ${detail.state.blockedReason}`);
  }
  if (
    detail.state.pendingDecision !== null &&
    !matchesThreadStateText(detail.state.pendingDecision, [
      detail.thread.title,
      detail.state.currentObjective?.title,
      detail.state.nextAction?.title
    ])
  ) {
    lines.push(`decision: ${detail.state.pendingDecision}`);
  }
  if (recentInboxItems.length > 0) {
    lines.push(formatPreviewSection("recent inbox", recentInboxItems, (item) => `${item.title} [${item.status}]`));
  }
  if (recentRuns.length > 0) {
    lines.push(formatPreviewSection("recent runs", recentRuns, (run) => `#${run.runNumber} ${run.status} | ${summarizeText(run.input)}`));
  }
  if (recentScheduleRuns.length > 0) {
    lines.push(
      formatPreviewSection(
        "recent schedules",
        recentScheduleRuns,
        (run) => `${run.scheduleId.slice(0, 8)} ${run.status} (${run.trigger})`
      )
    );
  }
  return [
    ...lines
  ].join("\n");
}

export function formatThreadRecapForTui(
  service: Pick<TuiRuntimeService, "showThread">,
  threadId: string
): string {
  const detail = service.showThread(threadId);
  if (detail.thread === null) {
    return `Thread ${threadId} not found.`;
  }

  const recentRuns = [...detail.runs]
    .filter(isConversationRecapRun)
    .sort((left, right) => byIsoDesc(left.createdAt, right.createdAt))
    .slice(0, 3)
    .reverse();
  const focusLines = formatThreadFocusLines(detail);
  const lines = [`Thread ${detail.thread.threadId.slice(0, 8)} | ${detail.thread.title}`];

  if (recentRuns.length === 0) {
    lines.push("No previous conversation yet.");
  } else {
    lines.push(
      formatPreviewSection("Previous conversation", recentRuns, (run) => formatRunRecapLine(run))
    );
  }

  if (focusLines.length > 0) {
    lines.push(`Current focus:\n${focusLines.map((line) => `- ${line}`).join("\n")}`);
  }

  return lines.join("\n");
}

function formatSection<TItem>(
  title: string,
  total: number,
  items: TItem[],
  toLine: (item: TItem) => string
): string {
  const head = `${title} (${total})`;
  if (items.length === 0) {
    return `${head}\n- none`;
  }
  return `${head}\n${items.map((item) => `- ${toLine(item)}`).join("\n")}`;
}

function formatPreviewSection<TItem>(
  title: string,
  items: TItem[],
  toLine: (item: TItem) => string
): string {
  return `${title}:\n${items.map((item) => `- ${toLine(item)}`).join("\n")}`;
}

function summarizeText(value: string, maxLength = 72): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function formatRunRecapLine(run: ThreadRunRecord): string {
  const output = threadRunFinalOutput(run);
  const userLine = `You: ${summarizeText(run.input, 120)}`;
  if (output !== null) {
    return `${userLine}\n- AutoTalon: ${summarizeText(output, 160)}`;
  }
  return `${userLine}\n- AutoTalon: ${formatRunStatus(run.status)}`;
}

function threadRunFinalOutput(run: ThreadRunRecord): string | null {
  const finalOutput = run.summary.finalOutput;
  return typeof finalOutput === "string" && finalOutput.trim().length > 0 ? finalOutput : null;
}

function formatRunStatus(status: ThreadRunRecord["status"]): string {
  switch (status) {
    case "succeeded":
      return "Completed.";
    case "failed":
      return "Stopped with an error.";
    case "cancelled":
      return "Cancelled.";
    case "waiting_approval":
      return "Waiting for approval.";
    case "waiting_clarification":
      return "Waiting for clarification.";
    case "waiting_tool":
      return "Waiting on a tool.";
    case "running":
      return "Still running.";
    default:
      return "Queued.";
  }
}

function formatThreadFocusLines(
  detail: ReturnType<TuiRuntimeService["showThread"]>
): string[] {
  if (detail.thread === null) {
    return [];
  }
  const candidates: string[] = [];
  if (detail.state.blockedReason !== null) {
    candidates.push(`Blocked: ${summarizeText(detail.state.blockedReason, 120)}`);
  }
  if (
    detail.state.currentObjective !== null &&
    shouldShowFocusText(detail.state.currentObjective.title, [detail.thread.title], detail.runs)
  ) {
    candidates.push(`Objective: ${summarizeText(detail.state.currentObjective.title, 120)}`);
  }
  if (
    detail.state.nextAction !== null &&
    shouldShowFocusText(detail.state.nextAction.title, [detail.thread.title, detail.state.currentObjective?.title], detail.runs)
  ) {
    candidates.push(`Next: ${summarizeText(detail.state.nextAction.title, 120)}`);
  }
  if (
    detail.state.pendingDecision !== null &&
    shouldShowFocusText(
      detail.state.pendingDecision,
      [detail.thread.title, detail.state.currentObjective?.title, detail.state.nextAction?.title],
      detail.runs
    )
  ) {
    candidates.push(`Decision needed: ${summarizeText(detail.state.pendingDecision, 120)}`);
  }
  return candidates;
}

function isConversationRecapRun(run: ThreadRunRecord): boolean {
  if (threadRunFinalOutput(run) !== null) {
    return true;
  }
  return run.status === "failed" || run.status === "cancelled" || run.status === "waiting_approval" || run.status === "waiting_clarification";
}

function shouldShowFocusText(
  value: string,
  duplicateCandidates: Array<string | null | undefined>,
  runs: ThreadRunRecord[]
): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || matchesThreadStateText(normalized, duplicateCandidates)) {
    return false;
  }
  if (looksLikeAssistantMarkdownFragment(normalized) || appearsInRunOutput(normalized, runs)) {
    return false;
  }
  return true;
}

function looksLikeAssistantMarkdownFragment(value: string): boolean {
  return value.includes("**") || value.includes("##") || value.startsWith("- ") || value.startsWith("* ");
}

function appearsInRunOutput(value: string, runs: ThreadRunRecord[]): boolean {
  const needle = normalizeForContentMatch(value);
  if (needle.length < 12) {
    return false;
  }
  return runs.some((run) => {
    const output = threadRunFinalOutput(run);
    return output !== null && normalizeForContentMatch(output).includes(needle);
  });
}

function isUsefulThreadInboxItem(item: InboxItem): boolean {
  if (item.category !== "task_completed") {
    return true;
  }
  const title = normalizeForComparison(item.title);
  return title !== "task completed" && !title.startsWith("routine completed:");
}

function matchesThreadStateText(value: string, candidates: Array<string | null | undefined>): boolean {
  const normalized = normalizeForComparison(value);
  if (normalized.length === 0) {
    return true;
  }
  return candidates.some((candidate) => normalizeForComparison(candidate ?? "") === normalized);
}

function normalizeForComparison(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function normalizeForContentMatch(value: string): string {
  return value
    .replace(/[*_`#>-]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function compareNextAction(
  left: NextActionRecord,
  right: NextActionRecord,
  activeThreadId: string | null
): number {
  if (activeThreadId !== null) {
    const leftActive = left.threadId === activeThreadId;
    const rightActive = right.threadId === activeThreadId;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
  }
  if (left.threadId !== right.threadId) {
    return left.threadId.localeCompare(right.threadId);
  }
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  return byIsoDesc(left.updatedAt, right.updatedAt);
}

function prioritizeByThread<TItem extends { threadId: string }>(
  items: TItem[],
  activeThreadId: string | null
): TItem[] {
  if (activeThreadId === null) {
    return items;
  }
  return [...items].sort((left, right) => {
    const leftActive = left.threadId === activeThreadId;
    const rightActive = right.threadId === activeThreadId;
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
    return 0;
  });
}

function byIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

function byIsoAsc(left: string, right: string): number {
  return left.localeCompare(right);
}

function isDueTodayOrOverdue(schedule: ScheduleRecord, now: Date): boolean {
  if (schedule.nextFireAt === null) {
    return false;
  }
  const nextFire = new Date(schedule.nextFireAt);
  if (Number.isNaN(nextFire.getTime())) {
    return false;
  }
  return nextFire.getTime() < startOfTomorrowLocal(now).getTime();
}

function compareDueRoutine(left: ScheduleRecord, right: ScheduleRecord): number {
  const leftFire = left.nextFireAt;
  const rightFire = right.nextFireAt;
  if (leftFire === null && rightFire === null) {
    return left.name.localeCompare(right.name);
  }
  if (leftFire === null) {
    return 1;
  }
  if (rightFire === null) {
    return -1;
  }
  return leftFire.localeCompare(rightFire);
}

function formatRoutineStatus(schedule: ScheduleRecord): string {
  if (schedule.nextFireAt === null) {
    return schedule.status;
  }
  const due = new Date(schedule.nextFireAt);
  if (!Number.isNaN(due.getTime()) && due.getTime() <= Date.now()) {
    return `overdue @ ${schedule.nextFireAt}`;
  }
  return `due @ ${schedule.nextFireAt}`;
}

function startOfTomorrowLocal(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}
