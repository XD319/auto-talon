import { z } from "zod";

import type { CreateScheduleInput, UpdateScheduleInput } from "../runtime/scheduler/index.js";
import {
  parseExecutionModeInput,
  previewScheduleTiming,
  readRepeatRemaining,
  readScheduleExecutionMode,
  readScheduleNoAgent,
  readScheduleSkills,
  readScheduleToolsets,
  resolveScheduleTiming,
  timingToCreateFields
} from "../runtime/scheduler/index.js";
import { readScheduleDeliveryTargets } from "../runtime/scheduler/schedule-delivery.js";
import { TOOLSET_NAMES } from "./toolsets.js";
import { SCHEDULE_STATUSES } from "../types/index.js";
import type {
  JsonObject,
  ScheduleListQuery,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleStatus,
  ToolAvailabilityResult,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const agentProfileSchema = z.enum(["executor", "planner", "reviewer"]);

const createActionSchema = z.object({
  action: z.literal("create"),
  agentProfileId: agentProfileSchema.optional(),
  allowDelegate: z.boolean().optional(),
  cron: z.string().optional(),
  every: z.string().optional(),
  executionMode: z.enum(["isolated", "continue", "session"]).optional(),
  name: z.string().min(1),
  noAgent: z
    .object({
      command: z.string().min(1),
      cwd: z.string().optional()
    })
    .optional(),
  prompt: z.string().min(1),
  repeatRemaining: z.number().int().positive().optional(),
  runAt: z.string().optional(),
  sessionId: z.string().optional(),
  skills: z.array(z.string().min(1)).optional(),
  timezone: z.string().optional(),
  toolsets: z.array(z.enum(TOOLSET_NAMES)).optional(),
  when: z.string().optional()
});

const listActionSchema = z.object({
  action: z.literal("list"),
  status: z.enum(SCHEDULE_STATUSES).optional()
});

const updateActionSchema = z.object({
  action: z.literal("update"),
  agentProfileId: agentProfileSchema.optional(),
  allowDelegate: z.boolean().optional(),
  cron: z.string().nullable().optional(),
  deliveryTargets: z.array(z.enum(["inbox", "origin", "silent", "webhook"])).optional(),
  every: z.string().nullable().optional(),
  executionMode: z.enum(["isolated", "continue", "session"]).optional(),
  name: z.string().min(1).optional(),
  noAgent: z
    .object({
      command: z.string().min(1),
      cwd: z.string().optional()
    })
    .nullable()
    .optional(),
  prompt: z.string().min(1).optional(),
  repeatRemaining: z.number().int().positive().nullable().optional(),
  runAt: z.string().nullable().optional(),
  scheduleId: z.string().min(1),
  sessionId: z.string().nullable().optional(),
  skills: z.array(z.string().min(1)).optional(),
  timezone: z.string().nullable().optional(),
  toolsets: z.array(z.enum(TOOLSET_NAMES)).optional()
});

const scheduleIdActionSchema = z.object({
  action: z.enum(["pause", "resume", "run", "remove"]),
  scheduleId: z.string().min(1)
});

const cronjobSchema = z.discriminatedUnion("action", [
  createActionSchema,
  listActionSchema,
  updateActionSchema,
  scheduleIdActionSchema
]);

export type CronjobToolInput = z.infer<typeof cronjobSchema>;

export type PreparedCronjobInput = CronjobToolInput;

export interface CronjobSchedulePort {
  archiveSchedule(scheduleId: string): ScheduleRecord;
  createSchedule(input: Omit<CreateScheduleInput, "providerName">): ScheduleRecord;
  listSchedules(query?: ScheduleListQuery): ScheduleRecord[];
  pauseSchedule(scheduleId: string): ScheduleRecord;
  resolveContinuationSessionId?(taskId: string): string | null;
  resumeSchedule(scheduleId: string): ScheduleRecord;
  runScheduleNow(scheduleId: string): ScheduleRunRecord;
  updateSchedule(scheduleId: string, input: UpdateScheduleInput): ScheduleRecord;
}

export class CronjobTool implements ToolDefinition<typeof cronjobSchema, PreparedCronjobInput> {
  public readonly name = "cronjob";
  public readonly description =
    "Manage scheduled background jobs: create, list, update, pause, resume, run now, or remove.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "none" as const;
  public readonly toolKind = "control_command" as const;
  public readonly inputSchema = cronjobSchema;

  private port: CronjobSchedulePort | null = null;

  public bindPort(port: CronjobSchedulePort): void {
    this.port = port;
  }

  public checkAvailability(context: ToolExecutionContext): ToolAvailabilityResult {
    if (isScheduleManagementBlocked(context)) {
      return {
        available: false,
        reason: "cronjob is not available while a scheduled run is executing"
      };
    }
    return { available: true, reason: "schedule management enabled" };
  }

  public prepare(input: unknown): ToolPreparation<PreparedCronjobInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: `cronjob ${parsed.action}`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "prompt",
        pathScope: "workspace",
        target: "interactive_user"
      }
    };
  }

  public async execute(
    preparedInput: PreparedCronjobInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (this.port === null) {
      return {
        errorCode: "tool_unavailable",
        errorMessage: "cronjob is not configured for this runtime.",
        success: false
      };
    }

    try {
      switch (preparedInput.action) {
        case "create": {
          const timing = resolveCreateTiming(preparedInput);
          const execution = parseExecutionModeInput(
            preparedInput.executionMode === "session" && preparedInput.sessionId !== undefined
              ? `session:${preparedInput.sessionId}`
              : preparedInput.executionMode
          );
          const schedule = this.port.createSchedule({
            agentProfileId: preparedInput.agentProfileId ?? context.agentProfileId,
            cwd: context.cwd,
            executionMode: execution.executionMode,
            input: preparedInput.prompt,
            name: preparedInput.name,
            ownerUserId: context.userId,
            ...(timing.cron !== undefined ? { cron: timing.cron } : {}),
            ...(timing.every !== undefined ? { every: timing.every } : {}),
            ...(timing.runAt !== undefined ? { runAt: timing.runAt } : {}),
            ...(preparedInput.allowDelegate !== undefined
              ? { allowDelegate: preparedInput.allowDelegate }
              : {}),
            ...(preparedInput.noAgent !== undefined
              ? {
                  noAgent: {
                    command: preparedInput.noAgent.command,
                    ...(preparedInput.noAgent.cwd !== undefined
                      ? { cwd: preparedInput.noAgent.cwd }
                      : {})
                  }
                }
              : {}),
            ...(preparedInput.repeatRemaining !== undefined
              ? { repeatRemaining: preparedInput.repeatRemaining }
              : {}),
            ...(preparedInput.skills !== undefined ? { skills: preparedInput.skills } : {}),
            ...(preparedInput.toolsets !== undefined ? { toolsets: preparedInput.toolsets } : {}),
            ...(execution.sessionId !== undefined
              ? { sessionId: execution.sessionId }
              : preparedInput.sessionId !== undefined
                ? { sessionId: preparedInput.sessionId }
                : execution.executionMode === "continue"
                  ? {
                      sessionId: this.port.resolveContinuationSessionId?.(context.taskId) ?? null
                    }
                  : {}),
            ...(preparedInput.timezone !== undefined ? { timezone: preparedInput.timezone } : {})
          });
          return successResult(`Created schedule ${schedule.scheduleId}`, serializeSchedule(schedule));
        }
        case "list": {
          const query =
            preparedInput.status === undefined ? undefined : { status: preparedInput.status as ScheduleStatus };
          const schedules = this.port.listSchedules(query);
          return successResult(`Listed ${schedules.length} schedule(s)`, {
            schedules: schedules.map(serializeSchedule)
          });
        }
        case "update": {
          const execution =
            preparedInput.executionMode === undefined
              ? null
              : parseExecutionModeInput(
                  preparedInput.executionMode === "session" && preparedInput.sessionId !== undefined
                    ? `session:${preparedInput.sessionId}`
                    : preparedInput.executionMode
                );
          const patch: UpdateScheduleInput = {
            ...(preparedInput.agentProfileId !== undefined
              ? { agentProfileId: preparedInput.agentProfileId }
              : {}),
            ...(preparedInput.allowDelegate !== undefined
              ? { allowDelegate: preparedInput.allowDelegate }
              : {}),
            ...(preparedInput.cron !== undefined ? { cron: preparedInput.cron } : {}),
            ...(preparedInput.deliveryTargets !== undefined
              ? { deliveryTargets: preparedInput.deliveryTargets }
              : {}),
            ...(preparedInput.every !== undefined ? { every: preparedInput.every } : {}),
            ...(execution !== null ? { executionMode: execution.executionMode } : {}),
            ...(preparedInput.name !== undefined ? { name: preparedInput.name } : {}),
            ...(preparedInput.noAgent !== undefined
              ? {
                  noAgent:
                    preparedInput.noAgent === null
                      ? null
                      : {
                          command: preparedInput.noAgent.command,
                          ...(preparedInput.noAgent.cwd !== undefined
                            ? { cwd: preparedInput.noAgent.cwd }
                            : {})
                        }
                }
              : {}),
            ...(preparedInput.prompt !== undefined ? { input: preparedInput.prompt } : {}),
            ...(preparedInput.repeatRemaining !== undefined
              ? { repeatRemaining: preparedInput.repeatRemaining }
              : {}),
            ...(preparedInput.runAt !== undefined ? { runAt: preparedInput.runAt } : {}),
            ...(execution?.sessionId !== undefined
              ? { sessionId: execution.sessionId }
              : preparedInput.sessionId !== undefined
                ? { sessionId: preparedInput.sessionId }
                : {}),
            ...(preparedInput.skills !== undefined ? { skills: preparedInput.skills } : {}),
            ...(preparedInput.timezone !== undefined ? { timezone: preparedInput.timezone } : {}),
            ...(preparedInput.toolsets !== undefined ? { toolsets: preparedInput.toolsets } : {})
          };
          const schedule = this.port.updateSchedule(preparedInput.scheduleId, patch);
          return successResult(`Updated schedule ${schedule.scheduleId}`, serializeSchedule(schedule));
        }
        case "pause": {
          const schedule = this.port.pauseSchedule(preparedInput.scheduleId);
          return successResult(`Paused schedule ${schedule.scheduleId}`, serializeSchedule(schedule));
        }
        case "resume": {
          const schedule = this.port.resumeSchedule(preparedInput.scheduleId);
          return successResult(`Resumed schedule ${schedule.scheduleId}`, serializeSchedule(schedule));
        }
        case "run": {
          const run = this.port.runScheduleNow(preparedInput.scheduleId);
          return successResult(`Enqueued schedule run ${run.runId}`, serializeRun(run));
        }
        case "remove": {
          const schedule = this.port.archiveSchedule(preparedInput.scheduleId);
          return successResult(`Archived schedule ${schedule.scheduleId}`, serializeSchedule(schedule));
        }
        default: {
          const unreachable: never = preparedInput;
          return {
            errorCode: "tool_validation_error",
            errorMessage: `Unsupported cronjob action: ${String(unreachable)}`,
            success: false
          };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "cronjob action failed";
      return {
        errorCode: "tool_execution_error",
        errorMessage: message,
        success: false
      };
    }
  }
}

function isScheduleManagementBlocked(context: ToolExecutionContext): boolean {
  const scheduleRunContext = context.taskMetadata?.scheduleRunContext;
  return (
    scheduleRunContext !== null &&
    typeof scheduleRunContext === "object" &&
    !Array.isArray(scheduleRunContext) &&
    (scheduleRunContext as Record<string, unknown>).disallowScheduleManagement === true
  );
}

function serializeSchedule(schedule: ScheduleRecord): JsonObject {
  const noAgent = readScheduleNoAgent(schedule);
  const timing = serializeScheduleTiming(schedule);
  return {
    agentProfileId: schedule.agentProfileId,
    allowDelegate: schedule.metadata.allowDelegate === true,
    cron: schedule.cron,
    deliveryTargets: readScheduleDeliveryTargets(schedule),
    executionMode: readScheduleExecutionMode(schedule),
    input: schedule.input,
    intervalMs: schedule.intervalMs,
    name: schedule.name,
    nextFireAt: schedule.nextFireAt,
    timing,
    ...(noAgent !== null
      ? { noAgent: { command: noAgent.command, ...(noAgent.cwd !== undefined ? { cwd: noAgent.cwd } : {}) } }
      : {}),
    repeatRemaining: readRepeatRemaining(schedule),
    runAt: schedule.runAt,
    scheduleId: schedule.scheduleId,
    sessionId: schedule.sessionId,
    skills: readScheduleSkills(schedule),
    status: schedule.status,
    timezone: schedule.timezone,
    toolsets: readScheduleToolsets(schedule)
  };
}

function serializeScheduleTiming(schedule: ScheduleRecord): JsonObject {
  if (schedule.cron !== null) {
    const preview = previewScheduleTiming({
      cron: schedule.cron,
      kind: "cron",
      timezone: schedule.timezone
    });
    return {
      kind: "cron",
      nextFireAt: preview.nextFireAt,
      nextFirePreview: preview.nextFirePreview,
      timezone: schedule.timezone,
      value: schedule.cron
    };
  }
  if (schedule.intervalMs !== null) {
    return {
      intervalMs: schedule.intervalMs,
      kind: "every",
      nextFireAt: schedule.nextFireAt,
      nextFirePreview: schedule.nextFireAt === null ? [] : [schedule.nextFireAt]
    };
  }
  return {
    kind: "runAt",
    nextFireAt: schedule.runAt,
    nextFirePreview: schedule.runAt === null ? [] : [schedule.runAt],
    value: schedule.runAt
  };
}

function serializeRun(run: ScheduleRunRecord): JsonObject {
  return {
    attemptNumber: run.attemptNumber,
    runId: run.runId,
    scheduleId: run.scheduleId,
    scheduledAt: run.scheduledAt,
    status: run.status,
    trigger: run.trigger
  };
}

function resolveCreateTiming(input: {
  cron?: string | undefined;
  every?: string | undefined;
  runAt?: string | undefined;
  when?: string | undefined;
}): Pick<CreateScheduleInput, "cron" | "every" | "runAt"> {
  const timing = resolveScheduleTiming({
    at: input.runAt,
    cron: input.cron,
    every: input.every,
    when: input.when
  });
  return timingToCreateFields(timing);
}

function successResult(summary: string, output: JsonObject): ToolExecutionResult {
  return {
    output,
    success: true,
    summary
  };
}
