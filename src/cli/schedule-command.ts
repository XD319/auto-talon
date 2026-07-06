import type { Command } from "commander";

import {
  createApplication,
  formatScheduleTimingPreview,
  parseExecutionModeInput,
  previewScheduleTiming,
  resolveDefaultUserId,
  resolveScheduleTiming,
  timingToCreateFields
} from "../runtime/index.js";
import {
  formatScheduleDetail,
  formatScheduleList,
  formatScheduleRunList,
  formatScheduleStatus
} from "./formatters.js";
import {
  parseNullableOption,
  parsePositiveIntegerOption,
  withApplication
} from "./cli-helpers.js";

interface ScheduleCreateOptions {
  at?: string;
  backoffBase: number;
  backoffMax: number;
  cron?: string;
  cwd?: string;
  every?: string;
  executionMode?: string;
  maxAttempts: number;
  name?: string;
  profile?: string;
  session?: string;
  timezone?: string;
}

interface ScheduleEditOptions {
  at?: string;
  backoffBase?: number;
  backoffMax?: number;
  cron?: string;
  every?: string;
  input?: string;
  maxAttempts?: number;
  name?: string;
  profile?: string;
  session?: string;
  timezone?: string;
}

export function registerScheduleCommands(program: Command): void {
  const scheduleCommand = program.command("schedule").description("Manage scheduled background jobs");
  scheduleCommand
    .command("create")
    .argument("<input>", "Scheduled task prompt")
    .requiredOption("--name <name>", "Schedule display name")
    .option("--every <duration>", "Recurring interval, e.g. 5m, 1h, 1d")
    .option("--at <iso>", "One-shot run time in ISO-8601")
    .option("--cron <expression>", "Cron expression")
    .option("--timezone <timezone>", "IANA timezone for cron, e.g. Asia/Shanghai")
    .option("--session <session_id>", "Continue an existing session")
    .option("--execution-mode <mode>", "isolated, continue, or session:<id>")
    .option("--profile <profile>", "Agent profile id", "executor")
    .option("--cwd <cwd>", "Working directory", process.cwd())
    .option("--max-attempts <num>", "Max retry attempts", parsePositiveIntegerOption("--max-attempts"), 3)
    .option("--backoff-base <ms>", "Backoff base milliseconds", parsePositiveIntegerOption("--backoff-base"), 5000)
    .option("--backoff-max <ms>", "Backoff max milliseconds", parsePositiveIntegerOption("--backoff-max"), 300000)
    .action((input: string, commandOptions: ScheduleCreateOptions) => {
      const cwd = commandOptions.cwd ?? process.cwd();
      const handle = createApplication(cwd);
      try {
        if (
          commandOptions.session !== undefined &&
          commandOptions.executionMode === undefined
        ) {
          throw new Error(
            "--session requires --execution-mode continue or session:<id>; isolated schedules ignore session binding."
          );
        }
        const ownerUserId = resolveDefaultUserId();
        const name = commandOptions.name ?? "scheduled-run";
        const profile = (commandOptions.profile ?? "executor") as "executor" | "planner" | "reviewer";
        const parsedExecutionMode =
          commandOptions.executionMode === undefined
            ? null
            : parseExecutionModeInput(
                commandOptions.executionMode.startsWith("session:")
                  ? commandOptions.executionMode
                  : commandOptions.session !== undefined && commandOptions.executionMode === "continue"
                    ? "continue"
                    : commandOptions.executionMode
              );
        const timing = resolveScheduleTiming({
          at: commandOptions.at,
          cron: commandOptions.cron,
          every: commandOptions.every,
          timezone: commandOptions.timezone
        });
        const schedule = handle.service.createSchedule({
          agentProfileId: profile,
          backoffBaseMs: commandOptions.backoffBase,
          backoffMaxMs: commandOptions.backoffMax,
          cwd,
          input,
          maxAttempts: commandOptions.maxAttempts,
          name,
          ownerUserId,
          providerName: handle.config.provider.name,
          ...timingToCreateFields(timing),
          ...(parsedExecutionMode !== null ? { executionMode: parsedExecutionMode.executionMode } : {}),
          ...(parsedExecutionMode?.sessionId !== undefined
            ? { sessionId: parsedExecutionMode.sessionId }
            : commandOptions.session !== undefined
              ? { sessionId: commandOptions.session }
              : {}),
          ...(commandOptions.timezone !== undefined ? { timezone: commandOptions.timezone } : {})
        });
        console.log(formatScheduleDetail(schedule));
      } finally {
        handle.close();
      }
    });
  scheduleCommand
    .command("preview")
    .argument("<when>", "Schedule expression: 30m, every 2h, cron, or ISO timestamp")
    .option("--timezone <timezone>", "IANA timezone for cron, e.g. Asia/Shanghai")
    .option("--count <count>", "Number of future fire times", parsePositiveIntegerOption("--count"), 5)
    .action((when: string, commandOptions: { count: number; timezone?: string }) => {
      const timing = resolveScheduleTiming({ timezone: commandOptions.timezone, when });
      console.log(formatScheduleTimingPreview(previewScheduleTiming(timing, commandOptions.count)));
    });
  scheduleCommand
    .command("list")
    .option("--status <status>", "Filter status: active | paused | completed | archived")
    .action((commandOptions: { status?: "active" | "paused" | "completed" | "archived" }) => {
      withApplication(process.cwd(), (handle) => {
        const query = commandOptions.status === undefined ? undefined : { status: commandOptions.status };
        console.log(formatScheduleList(handle.service.listSchedules(query)));
      });
    });
  scheduleCommand.command("show").argument("<schedule_id>").action((scheduleId: string) => {
    withApplication(process.cwd(), (handle) => {
      const schedule = handle.service.showSchedule(scheduleId);
      if (schedule === null) {
        console.error(`Schedule ${scheduleId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatScheduleDetail(schedule));
    });
  });
  scheduleCommand
    .command("edit")
    .argument("<schedule_id>")
    .option("--name <name>", "Schedule display name")
    .option("--input <input>", "Scheduled task prompt")
    .option("--every <duration>", "Recurring interval, e.g. 5m, 1h, 1d")
    .option("--at <iso>", "One-shot run time in ISO-8601")
    .option("--cron <expression>", "Cron expression")
    .option("--timezone <timezone>", "IANA timezone for cron, e.g. Asia/Shanghai")
    .option("--session <session_id>", "Continue an existing session; use none to clear")
    .option("--profile <profile>", "Agent profile id")
    .option("--max-attempts <num>", "Max retry attempts", parsePositiveIntegerOption("--max-attempts"))
    .option("--backoff-base <ms>", "Backoff base milliseconds", parsePositiveIntegerOption("--backoff-base"))
    .option("--backoff-max <ms>", "Backoff max milliseconds", parsePositiveIntegerOption("--backoff-max"))
    .action((scheduleId: string, commandOptions: ScheduleEditOptions) => {
      withApplication(process.cwd(), (handle) => {
        const timingTouched =
          commandOptions.at !== undefined ||
          commandOptions.every !== undefined ||
          commandOptions.cron !== undefined;
        const timingFields = timingTouched
          ? timingToCreateFields(
              resolveScheduleTiming({
                at: commandOptions.at,
                cron: commandOptions.cron,
                every: commandOptions.every,
                timezone: commandOptions.timezone
              })
            )
          : {};
        const updated = handle.service.updateSchedule(scheduleId, {
          ...(commandOptions.backoffBase !== undefined
            ? { backoffBaseMs: commandOptions.backoffBase }
            : {}),
          ...(commandOptions.backoffMax !== undefined
            ? { backoffMaxMs: commandOptions.backoffMax }
            : {}),
          ...timingFields,
          ...(commandOptions.input !== undefined ? { input: commandOptions.input } : {}),
          ...(commandOptions.maxAttempts !== undefined
            ? { maxAttempts: commandOptions.maxAttempts }
            : {}),
          ...(commandOptions.name !== undefined ? { name: commandOptions.name } : {}),
          ...(commandOptions.profile !== undefined
            ? { agentProfileId: commandOptions.profile as "executor" | "planner" | "reviewer" }
            : {}),
          ...(commandOptions.session !== undefined ? { sessionId: parseNullableOption(commandOptions.session) } : {}),
          ...(commandOptions.timezone !== undefined ? { timezone: commandOptions.timezone } : {})
        });
        console.log(formatScheduleDetail(updated));
      });
    });
  scheduleCommand.command("pause").argument("<schedule_id>").action((scheduleId: string) => {
    withApplication(process.cwd(), (handle) => {
      console.log(formatScheduleDetail(handle.service.pauseSchedule(scheduleId)));
    });
  });
  scheduleCommand.command("resume").argument("<schedule_id>").action((scheduleId: string) => {
    withApplication(process.cwd(), (handle) => {
      console.log(formatScheduleDetail(handle.service.resumeSchedule(scheduleId)));
    });
  });
  scheduleCommand.command("run-now").argument("<schedule_id>").action((scheduleId: string) => {
    withApplication(process.cwd(), (handle) => {
      const run = handle.service.runScheduleNow(scheduleId);
      console.log(formatScheduleRunList([run]));
    });
  });
  scheduleCommand
    .command("runs")
    .argument("<schedule_id>")
    .option("--status <status>", "Filter status")
    .option("--tail <count>", "Number of latest runs", parsePositiveIntegerOption("--tail"), 20)
    .action((scheduleId: string, commandOptions: { status?: string; tail: number }) => {
      withApplication(process.cwd(), (handle) => {
        const parsedStatus = commandOptions.status as
          | "queued"
          | "running"
          | "waiting_approval"
          | "blocked"
          | "completed"
          | "failed"
          | "cancelled"
          | undefined;
        const query =
          parsedStatus === undefined
            ? { tail: commandOptions.tail }
            : { status: parsedStatus, tail: commandOptions.tail };
        const runs = handle.service.listScheduleRuns(scheduleId, query);
        console.log(formatScheduleRunList(runs));
      });
    });
  scheduleCommand.command("remove").argument("<schedule_id>").description("Archive a schedule").action((scheduleId: string) => {
    withApplication(process.cwd(), (handle) => {
      console.log(formatScheduleDetail(handle.service.archiveSchedule(scheduleId)));
    });
  });
  scheduleCommand.command("status").description("Summarize schedules and queued runs").action(() => {
    withApplication(process.cwd(), (handle) => {
      console.log(formatScheduleStatus(handle.service.scheduleStatus()));
    });
  });
  scheduleCommand.command("tick").description("Run one scheduler tick and exit").action(async () => {
    const handle = createApplication(process.cwd());
    try {
      await handle.service.tickScheduleOnce();
      console.log(formatScheduleStatus(handle.service.scheduleStatus()));
    } finally {
      handle.close();
    }
  });
  scheduleCommand
    .command("run [schedule_id]")
    .description("Run scheduler daemon, or trigger a schedule and optionally wait")
    .option("--wait", "Wait until the triggered run reaches a terminal status")
    .option("--timeout <ms>", "Wait timeout in milliseconds", parsePositiveIntegerOption("--timeout"), 300_000)
    .option("--poll-interval <ms>", "Polling interval while waiting", parsePositiveIntegerOption("--poll-interval"), 500)
    .action(async (
      scheduleId: string | undefined,
      commandOptions: { wait?: boolean; timeout: number; pollInterval: number }
    ) => {
      if (scheduleId === undefined) {
        const handle = createApplication(process.cwd(), {
          scheduler: { autoStart: true }
        });
        console.log("Scheduler started. Press Ctrl+C to stop.");
        await new Promise<void>((resolve) => {
          process.on("SIGINT", () => {
            handle.close();
            resolve();
          });
        });
        return;
      }

      const handle = createApplication(process.cwd(), {
        scheduler: { autoStart: true }
      });
      try {
        const run = handle.service.runScheduleNow(scheduleId);
        console.log(formatScheduleRunList([run]));
        if (commandOptions.wait !== true) {
          return;
        }
        const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
        const deadline = Date.now() + commandOptions.timeout;
        while (Date.now() < deadline) {
          await handle.service.tickScheduleOnce();
          const latest =
            handle.service.listScheduleRuns(scheduleId, { tail: 20 }).find((entry) => entry.runId === run.runId) ??
            run;
          if (terminalStatuses.has(latest.status)) {
            console.log(formatScheduleRunList([latest]));
            if (latest.status !== "completed") {
              process.exitCode = 1;
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, commandOptions.pollInterval));
        }
        console.error(`Timed out waiting for schedule run ${run.runId}.`);
        process.exitCode = 1;
      } finally {
        handle.close();
      }
    });
}
