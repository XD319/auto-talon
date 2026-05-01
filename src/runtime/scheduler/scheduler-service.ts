import { randomUUID } from "node:crypto";

import { computeNextFireAt, parseEveryExpression } from "./next-fire.js";

import type { JobRunner } from "../jobs/job-runner.js";
import type { TraceService } from "../../tracing/trace-service.js";
import { SCHEDULE_DELIVERY_TARGETS, SCHEDULE_RUN_STATUSES, SCHEDULE_STATUSES } from "../../types/index.js";
import type {
  JsonObject,
  ScheduleDeliveryTarget,
  ScheduleDraft,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRepository,
  ScheduleRunListQuery,
  ScheduleRunRecord,
  ScheduleRunRepository,
  ScheduleStatusSummary
} from "../../types/index.js";

export interface CreateScheduleInput {
  name: string;
  ownerUserId: string;
  cwd: string;
  agentProfileId: ScheduleRecord["agentProfileId"];
  providerName: string;
  input: string;
  threadId?: string | null;
  runAt?: string | null;
  every?: string | null;
  cron?: string | null;
  timezone?: string | null;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  metadata?: JsonObject;
  deliveryTargets?: ScheduleDeliveryTarget[];
}

export interface UpdateScheduleInput {
  agentProfileId?: ScheduleRecord["agentProfileId"];
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cron?: string | null;
  deliveryTargets?: ScheduleDeliveryTarget[];
  every?: string | null;
  input?: string;
  maxAttempts?: number;
  metadata?: JsonObject;
  name?: string;
  runAt?: string | null;
  threadId?: string | null;
  timezone?: string | null;
}

export interface SchedulerServiceDependencies {
  scheduleRepository: ScheduleRepository;
  scheduleRunRepository: ScheduleRunRepository;
  jobRunner: JobRunner;
  traceService: TraceService;
  pollIntervalMs?: number;
}

export class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;

  public constructor(private readonly dependencies: SchedulerServiceDependencies) {}

  public start(): void {
    if (this.timer !== null) {
      return;
    }
    const pollIntervalMs = this.dependencies.pollIntervalMs ?? 2_000;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown scheduler tick error.";
        this.dependencies.traceService.record({
          actor: "scheduler",
          eventType: "schedule_run_failed",
          payload: {
            attemptNumber: 0,
            errorCode: null,
            errorMessage: message,
            runId: "scheduler_tick",
            scheduleId: "scheduler",
            taskId: null
          },
          stage: "control",
          summary: "Scheduler tick failed",
          taskId: "scheduler:tick"
        });
      });
    }, pollIntervalMs);
  }

  public stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async tick(now = new Date()): Promise<void> {
    if (this.tickInProgress) {
      return;
    }
    this.tickInProgress = true;
    try {
      const nowIso = now.toISOString();
      const dueSchedules = this.dependencies.scheduleRepository.findDue({ now: nowIso, limit: 25 });
      for (const schedule of dueSchedules) {
        this.enqueueScheduledRun(schedule, now);
      }
      await this.dependencies.jobRunner.drain(nowIso);
    } finally {
      this.tickInProgress = false;
    }
  }

  public async tickOnce(now = new Date()): Promise<void> {
    await this.tick(now);
  }

  public createSchedule(input: CreateScheduleInput): ScheduleRecord {
    const draft = this.buildScheduleDraft(input);
    const schedule = this.dependencies.scheduleRepository.create(draft);
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_created",
      payload: {
        nextFireAt: schedule.nextFireAt,
        scheduleId: schedule.scheduleId,
        status: schedule.status === "paused" ? "paused" : "active"
      },
      stage: "control",
      summary: `Schedule ${schedule.scheduleId} created`,
      taskId: `schedule:${schedule.scheduleId}`
    });
    return schedule;
  }

  public listSchedules(query?: ScheduleListQuery): ScheduleRecord[] {
    return this.dependencies.scheduleRepository.list(query);
  }

  public showSchedule(scheduleId: string): ScheduleRecord | null {
    return this.dependencies.scheduleRepository.findById(scheduleId);
  }

  public listScheduleRuns(scheduleId: string, query?: ScheduleRunListQuery): ScheduleRunRecord[] {
    return this.dependencies.scheduleRunRepository.listByScheduleId(scheduleId, query);
  }

  public updateSchedule(scheduleId: string, input: UpdateScheduleInput): ScheduleRecord {
    const existing = this.dependencies.scheduleRepository.findById(scheduleId);
    if (existing === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    if (existing.status === "archived") {
      throw new Error(`Schedule ${scheduleId} is archived and cannot be edited.`);
    }

    const patch = this.buildScheduleUpdatePatch(existing, input);
    const updated = this.dependencies.scheduleRepository.update(scheduleId, patch);
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_updated",
      payload: {
        nextFireAt: updated.nextFireAt,
        scheduleId: updated.scheduleId,
        status: updated.status
      },
      stage: "control",
      summary: `Schedule ${updated.scheduleId} updated`,
      taskId: `schedule:${updated.scheduleId}`
    });
    return updated;
  }

  public archiveSchedule(scheduleId: string): ScheduleRecord {
    const existing = this.dependencies.scheduleRepository.findById(scheduleId);
    if (existing === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    const archived = this.dependencies.scheduleRepository.update(scheduleId, {
      nextFireAt: null,
      status: "archived"
    });
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_archived",
      payload: {
        scheduleId: archived.scheduleId,
        status: "archived"
      },
      stage: "control",
      summary: `Schedule ${archived.scheduleId} archived`,
      taskId: `schedule:${archived.scheduleId}`
    });
    return archived;
  }

  public status(now = new Date()): ScheduleStatusSummary {
    const nowIso = now.toISOString();
    const schedules = this.dependencies.scheduleRepository.list();
    const runs = this.dependencies.scheduleRunRepository.list({ tail: 10_000 });
    const scheduleCounts = Object.fromEntries(SCHEDULE_STATUSES.map((status) => [status, 0])) as ScheduleStatusSummary["schedules"];
    const runCounts = Object.fromEntries(SCHEDULE_RUN_STATUSES.map((status) => [status, 0])) as ScheduleStatusSummary["runs"];
    for (const schedule of schedules) {
      scheduleCounts[schedule.status] += 1;
    }
    for (const run of runs) {
      runCounts[run.status] += 1;
    }
    const activeSchedules = schedules.filter((schedule) => schedule.status === "active");
    const nextFireAt = activeSchedules
      .map((schedule) => schedule.nextFireAt)
      .filter((value): value is string => value !== null)
      .sort()[0] ?? null;
    return {
      dueCount: activeSchedules.filter((schedule) => schedule.nextFireAt !== null && schedule.nextFireAt <= nowIso).length,
      lastRunAt: runs[0]?.scheduledAt ?? null,
      nextFireAt,
      runs: runCounts,
      schedules: scheduleCounts
    };
  }

  public pauseSchedule(scheduleId: string): ScheduleRecord {
    const existing = this.dependencies.scheduleRepository.findById(scheduleId);
    if (existing?.status === "archived") {
      throw new Error(`Schedule ${scheduleId} is archived and cannot be paused.`);
    }
    const schedule = this.dependencies.scheduleRepository.update(scheduleId, { status: "paused" });
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_paused",
      payload: {
        scheduleId: schedule.scheduleId,
        status: "paused"
      },
      stage: "control",
      summary: `Schedule ${schedule.scheduleId} paused`,
      taskId: `schedule:${schedule.scheduleId}`
    });
    return schedule;
  }

  public resumeSchedule(scheduleId: string): ScheduleRecord {
    const existing = this.dependencies.scheduleRepository.findById(scheduleId);
    if (existing === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    if (existing.status === "archived") {
      throw new Error(`Schedule ${scheduleId} is archived and cannot be resumed.`);
    }
    const resumed = this.dependencies.scheduleRepository.update(scheduleId, {
      nextFireAt: this.computeResumeFireAt(existing),
      status: "active"
    });
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_resumed",
      payload: {
        nextFireAt: resumed.nextFireAt,
        scheduleId: resumed.scheduleId,
        status: "active"
      },
      stage: "control",
      summary: `Schedule ${resumed.scheduleId} resumed`,
      taskId: `schedule:${resumed.scheduleId}`
    });
    return resumed;
  }

  public runNow(scheduleId: string): ScheduleRunRecord {
    const schedule = this.dependencies.scheduleRepository.findById(scheduleId);
    if (schedule === null) {
      throw new Error(`Schedule ${scheduleId} was not found.`);
    }
    if (schedule.status === "archived") {
      throw new Error(`Schedule ${scheduleId} is archived and cannot be run.`);
    }
    const latest = this.dependencies.scheduleRunRepository.listByScheduleId(scheduleId, { tail: 1 });
    const run = this.dependencies.scheduleRunRepository.create({
      attemptNumber: (latest[0]?.attemptNumber ?? 0) + 1,
      runId: randomUUID(),
      scheduleId,
      scheduledAt: new Date().toISOString(),
      status: "queued",
      trigger: "manual"
    });
    this.recordRunEnqueued(run);
    return run;
  }

  private enqueueScheduledRun(schedule: ScheduleRecord, now: Date): ScheduleRunRecord {
    const latest = this.dependencies.scheduleRunRepository.listByScheduleId(schedule.scheduleId, { tail: 1 });
    const run = this.dependencies.scheduleRunRepository.create({
      attemptNumber: (latest[0]?.attemptNumber ?? 0) + 1,
      runId: randomUUID(),
      scheduleId: schedule.scheduleId,
      scheduledAt: now.toISOString(),
      status: "queued",
      trigger: "scheduled"
    });
    const nextFire = computeNextFireAt(schedule, now);
    this.dependencies.scheduleRepository.update(schedule.scheduleId, {
      lastFireAt: now.toISOString(),
      nextFireAt: nextFire?.toISOString() ?? null,
      status: nextFire === null ? "completed" : schedule.status
    });
    this.recordRunEnqueued(run);
    return run;
  }

  private recordRunEnqueued(run: ScheduleRunRecord): void {
    this.dependencies.traceService.record({
      actor: "scheduler",
      eventType: "schedule_run_enqueued",
      payload: {
        attemptNumber: run.attemptNumber,
        runId: run.runId,
        scheduledAt: run.scheduledAt,
        scheduleId: run.scheduleId,
        trigger: run.trigger
      },
      stage: "control",
      summary: `Schedule run ${run.runId} enqueued`,
      taskId: `schedule:${run.scheduleId}`
    });
  }

  private buildScheduleDraft(input: CreateScheduleInput): ScheduleDraft {
    const intervalMs = input.every === undefined || input.every === null ? null : parseEveryExpression(input.every);
    const runAt = input.runAt ?? null;
    const cron = input.cron ?? null;
    if (intervalMs === null && cron === null && runAt === null) {
      throw new Error("Schedule must define one of runAt, every, or cron.");
    }
    const nextFireAt =
      runAt !== null
        ? runAt
        : computeNextFireAt(
            {
              cron,
              intervalMs,
              timezone: input.timezone ?? null
            },
            new Date()
          )?.toISOString() ?? null;
    return {
      agentProfileId: input.agentProfileId,
      backoffBaseMs: input.backoffBaseMs ?? 5_000,
      backoffMaxMs: input.backoffMaxMs ?? 300_000,
      cron,
      cwd: input.cwd,
      input: input.input,
      intervalMs,
      maxAttempts: input.maxAttempts ?? 3,
      metadata: withDeliveryMetadata(input.metadata ?? {}, input.deliveryTargets ?? ["inbox"]),
      name: input.name,
      nextFireAt,
      ownerUserId: input.ownerUserId,
      providerName: input.providerName,
      runAt,
      scheduleId: randomUUID(),
      threadId: input.threadId ?? null,
      timezone: input.timezone ?? null
    };
  }

  private computeResumeFireAt(schedule: ScheduleRecord): string | null {
    if (schedule.runAt !== null) {
      return schedule.runAt;
    }
    return computeNextFireAt(schedule, new Date())?.toISOString() ?? null;
  }

  private buildScheduleUpdatePatch(existing: ScheduleRecord, input: UpdateScheduleInput): Parameters<ScheduleRepository["update"]>[1] {
    const patch: Parameters<ScheduleRepository["update"]>[1] = {
      ...(input.agentProfileId !== undefined ? { agentProfileId: input.agentProfileId } : {}),
      ...(input.backoffBaseMs !== undefined ? { backoffBaseMs: input.backoffBaseMs } : {}),
      ...(input.backoffMaxMs !== undefined ? { backoffMaxMs: input.backoffMaxMs } : {}),
      ...(input.input !== undefined ? { input: input.input } : {}),
      ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      ...(input.timezone !== undefined ? { timezone: input.timezone } : {})
    };

    const metadataBase =
      input.metadata === undefined
        ? existing.metadata
        : {
            ...existing.metadata,
            ...input.metadata
          };
    const nextMetadata =
      input.metadata !== undefined || input.deliveryTargets !== undefined
        ? withDeliveryMetadata(metadataBase, input.deliveryTargets)
        : undefined;
    if (nextMetadata !== undefined) {
      patch.metadata = nextMetadata;
    }

    const timingTouched = hasOwn(input, "runAt") || hasOwn(input, "every") || hasOwn(input, "cron");
    if (timingTouched) {
      const requestedModes = [
        input.runAt !== undefined && input.runAt !== null ? "runAt" : null,
        input.every !== undefined && input.every !== null ? "every" : null,
        input.cron !== undefined && input.cron !== null ? "cron" : null
      ].filter((mode): mode is "runAt" | "every" | "cron" => mode !== null);
      if (requestedModes.length !== 1) {
        throw new Error("Schedule edit must define exactly one of runAt, every, or cron when changing time.");
      }
      const timezone = input.timezone ?? existing.timezone;
      if (requestedModes[0] === "runAt") {
        patch.runAt = input.runAt ?? null;
        patch.intervalMs = null;
        patch.cron = null;
        patch.nextFireAt = input.runAt ?? null;
      } else if (requestedModes[0] === "every") {
        const intervalMs = parseEveryExpression(input.every ?? "");
        patch.runAt = null;
        patch.intervalMs = intervalMs;
        patch.cron = null;
        patch.nextFireAt = computeNextFireAt({ intervalMs, cron: null, timezone }, new Date())?.toISOString() ?? null;
      } else {
        const cron = input.cron ?? null;
        patch.runAt = null;
        patch.intervalMs = null;
        patch.cron = cron;
        patch.nextFireAt = computeNextFireAt({ intervalMs: null, cron, timezone }, new Date())?.toISOString() ?? null;
      }
      if (existing.status === "completed" && patch.nextFireAt !== null) {
        patch.status = "active";
      }
      return patch;
    }

    if (input.timezone !== undefined && existing.runAt === null) {
      patch.nextFireAt = computeNextFireAt(
        {
          cron: existing.cron,
          intervalMs: existing.intervalMs,
          timezone: input.timezone
        },
        new Date()
      )?.toISOString() ?? null;
    }

    return patch;
  }
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function withDeliveryMetadata(metadata: JsonObject, targets?: ScheduleDeliveryTarget[]): JsonObject {
  if (targets === undefined) {
    return metadata;
  }
  const normalizedTargets = normalizeDeliveryTargets(targets);
  const currentDelivery = metadata.delivery;
  const delivery =
    currentDelivery !== null && typeof currentDelivery === "object" && !Array.isArray(currentDelivery)
      ? currentDelivery
      : {};
  return {
    ...metadata,
    delivery: {
      ...delivery,
      targets: normalizedTargets
    }
  };
}

function normalizeDeliveryTargets(targets: ScheduleDeliveryTarget[]): ScheduleDeliveryTarget[] {
  const normalized = [...new Set(targets)];
  if (normalized.length === 0) {
    throw new Error("Schedule delivery targets must include at least one target.");
  }
  for (const target of normalized) {
    if (!SCHEDULE_DELIVERY_TARGETS.includes(target)) {
      throw new Error(`Unsupported schedule delivery target: ${target}`);
    }
  }
  return normalized;
}
