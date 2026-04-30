import type { AgentApplicationService } from "../../runtime/index.js";
import type {
  ApprovalRecord,
  CommitmentRecord,
  InboxItem,
  NextActionRecord,
  ScheduleRecord,
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
  service: AgentApplicationService,
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
  service: AgentApplicationService,
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
  if (detail.state.pendingDecision !== null) {
    lines.push(`decision: ${detail.state.pendingDecision}`);
  }
  if (detail.inboxItems.length > 0) {
    lines.push(formatPreviewSection("recent inbox", detail.inboxItems.slice(0, 2), (item) => `${item.title} [${item.status}]`));
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
