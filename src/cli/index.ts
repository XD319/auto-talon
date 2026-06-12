import { writeFileSync } from "node:fs";

import { Command, InvalidArgumentError } from "commander";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  createGatewayApplication,
  createGatewayRuntime,
  createFeishuGatewayPlugin,
  hasFeishuGatewayConfig,
  startFeishuGateway,
  startLocalWebhookGateway,
  GatewayManager,
  LocalWebhookAdapter
} from "../gateway/index.js";
import {
  McpServer,
  McpSkillBridge,
  McpStdioHost,
  McpToolBridge,
  resolveMcpServerConfig
} from "../mcp/index.js";
import {
  replayTaskById,
  runBetaReadinessCheck,
  runCodingEvalReport,
  runEvalReport,
  runReleaseChecklist
} from "../diagnostics/index.js";
import {
  promoteProviderConfig,
  setupProviderConfig,
  useProviderConfig,
  type ProviderConfigScope,
  type ProviderConfigWriteResult,
  type SupportedProviderName
} from "../providers/index.js";
import {
  buildRepoMap,
  createApplication,
  createDefaultRunOptions,
  formatScheduleTimingPreview,
  parseExecutionModeInput,
  previewScheduleTiming,
  resolveScheduleTiming,
  initializeWorkspaceFiles,
  resolveAppConfig,
  timingToCreateFields,
  RUNTIME_VERSION,
  type ResolveAppConfigOptions
} from "../runtime/index.js";
import { runGitReadOnly } from "../runtime/workspace/git-readonly.js";
import { formatSmokeSuiteReport, runSmokeSuite } from "../testing/index.js";
import { startDashboardTui, startTui } from "../tui/index.js";
import { startSessionApiServer } from "../session-api/server.js";

import {
  formatApprovalList,
  formatAuditLog,
  formatBetaReadinessReport,
  formatCodingEvalReport,
  formatCommitmentDetail,
  formatCommitmentList,
  formatCurrentProvider,
  formatDoctorReport,
  formatEvalReport,
  formatReleaseChecklistReport,
  formatExperienceDetail,
  formatExperienceList,
  formatExperienceSearch,
  formatInboxDetail,
  formatInboxList,
  formatMemoryList,
  formatMemoryGuide,
  formatMemoryRecallExplanation,
  formatMemoryScope,
  formatMemorySuggestionQueue,
  formatNextActionList,
  formatProviderCatalog,
  formatProviderHealth,
  formatProviderSmoke,
  formatProviderStats,
  formatScheduleDetail,
  formatScheduleList,
  formatScheduleRunList,
  formatScheduleStatus,
  formatReplayReport,
  formatRunError,
  formatSkillDraft,
  formatSkillList,
  formatSkillView,
  formatToolList,
  formatSnapshot,
  formatTask,
  formatTaskList,
  formatTaskTimeline,
  formatSessionDetail,
  formatSessionList,
  formatSessionSummary,
  formatSessionSummaryList,
  formatSessionSummarySearchHits,
  formatTrace,
  formatTraceContextDebug,
  summarizeAudit,
  summarizeTrace
} from "./formatters.js";
import type {
  ApprovalAllowScope,
  CommitmentRecord,
  ExperienceQuery,
  ExperienceSourceType,
  ExperienceStatus,
  ExperienceType,
  RuntimeOutputEvent
} from "../types/index.js";
import type { InboundMessageAdapter } from "../types/index.js";
import type { SkillAttachmentKind } from "../types/skill.js";

export async function main(argv = process.argv): Promise<void> {
  const program = new Command();
  program.name("talon").description("Agent Runtime MVP CLI").version("0.1.0");

  program.command("version").description("Show runtime and environment version").action(() => {
    console.log(`auto-talon v${program.version()}`);
    console.log(`runtimeVersion=${RUNTIME_VERSION}`);
    console.log(`node=${process.version}`);
  });

  program
    .command("run")
    .argument("<task>", "Task prompt to execute")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--profile <profile>", "Agent profile", "executor")
    .option("--mode <mode>", "Interaction mode: agent | plan", "agent")
    .option("--session <sessionId>", "Reuse an existing session id")
    .option("--max-iterations <number>", "Maximum loop iterations", parsePositiveIntegerOption("--max-iterations"))
    .option("--timeout-ms <number>", "Task timeout in milliseconds", parsePositiveIntegerOption("--timeout-ms"))
    .option("--json-events", "Write runtime output events as NDJSON on stderr")
    .action(async (task: string, commandOptions: RunCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const runOptions = createDefaultRunOptions(task, commandOptions.cwd, handle.config);
        runOptions.agentProfileId = commandOptions.profile as typeof runOptions.agentProfileId;
        if (commandOptions.mode === "plan") {
          runOptions.interactionMode = "plan";
          runOptions.agentProfileId = "planner";
        }
        if (commandOptions.session !== undefined) {
          runOptions.sessionId = commandOptions.session;
        }
        if (commandOptions.maxIterations !== undefined) {
          runOptions.maxIterations = commandOptions.maxIterations;
        }
        if (commandOptions.timeoutMs !== undefined) {
          runOptions.timeoutMs = commandOptions.timeoutMs;
        }
        runOptions.onOutputEvent = createCliOutputListener(commandOptions.jsonEvents === true);

        const result = await handle.service.runTask(runOptions);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
        console.log(formatProviderStats(handle.service.providerStats()));
        if (result.error !== undefined) {
          console.error(`Error: ${formatRunError(result.error)}`);
          process.exitCode = 1;
        }
      } finally {
        handle.close();
      }
    });

  program
    .command("continue")
    .argument("[task]", "Task prompt to continue in a session")
    .option("--last", "Continue the latest session for current user")
    .option("--session <sessionId>", "Continue a specific session id")
    .option("--cwd <path>", "Working directory", process.cwd())
    .option("--json-events", "Write runtime output events as NDJSON on stderr")
    .action(async (task: string | undefined, commandOptions: { cwd: string; jsonEvents?: boolean; last?: boolean; session?: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const sessionInput =
          commandOptions.session !== undefined && task === undefined
            ? handle.service.listNextActions({ sessionId: commandOptions.session, statuses: ["active", "pending"] })[0]
                ?.title
            : task;
        const result =
          commandOptions.session !== undefined
            ? await (async () => {
                const sessionId = commandOptions.session;
                if (sessionId === undefined) {
                  throw new Error("Session id is required.");
                }
                if (sessionInput === undefined) {
                  throw new Error("No task input or next action found.");
                }
                return handle.service.continueSession(sessionId, sessionInput, {
                  cwd: commandOptions.cwd,
                  onOutputEvent: createCliOutputListener(commandOptions.jsonEvents === true)
                });
              })()
            : commandOptions.last === true
              ? await handle.service.continueLatest(task, {
                  cwd: commandOptions.cwd,
                  onOutputEvent: createCliOutputListener(commandOptions.jsonEvents === true)
                })
              : await handle.service.continueLatest(task, {
                  cwd: commandOptions.cwd,
                  onOutputEvent: createCliOutputListener(commandOptions.jsonEvents === true)
                });
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Session ID: ${result.task.sessionId ?? "-"}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
      } finally {
        handle.close();
      }
    });

  const taskCommand = program.command("task").description("Inspect persisted tasks");

  const sessionCommand = program.command("session").description("Inspect persisted sessions");
  sessionCommand
    .command("list")
    .option("--status <status>", "Filter status: active | archived | deleted")
    .option("--json", "Print JSON")
    .action((commandOptions: { json?: boolean; status?: "active" | "archived" | "deleted" }) => {
      const handle = createApplication(process.cwd());
      try {
        const sessions = handle.service.listSessions(commandOptions.status);
        console.log(
          commandOptions.json === true ? JSON.stringify(sessions, null, 2) : formatSessionList(sessions)
        );
      } finally {
        handle.close();
      }
    });
  sessionCommand.command("show").argument("<session_id>", "Session identifier").action((sessionId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const result = handle.service.showSession(sessionId);
      if (result.session === null) {
        console.error(`Session ${sessionId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(
        formatSessionDetail(
          result.session,
          result.tasks,
          result.lineage,
          result.inboxItems,
          result.commitments,
          result.nextActions,
          result.state
        )
      );
    } finally {
      handle.close();
    }
  });
  sessionCommand.command("archive").argument("<session_id>", "Session identifier").action((sessionId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const session = handle.service.archiveSession(sessionId);
      console.log(`Archived session: ${session.sessionId}`);
    } finally {
      handle.close();
    }
  });
  sessionCommand
    .command("summaries")
    .argument("<session_id>", "Session identifier")
    .action((sessionId: string) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatSessionSummaryList(handle.service.listSessionSummaries(sessionId)));
      } finally {
        handle.close();
      }
    });
  sessionCommand
    .command("summary")
    .argument("<summary_id>", "Session summary identifier")
    .action((summaryId: string) => {
      const handle = createApplication(process.cwd());
      try {
        const summary = handle.service.showSessionSummary(summaryId);
        if (summary === null) {
          console.error(`Session summary ${summaryId} not found.`);
          process.exitCode = 1;
          return;
        }
        console.log(formatSessionSummary(summary));
      } finally {
        handle.close();
      }
    });

  sessionCommand
    .command("search")
    .argument("<query>", "Full-text query")
    .option("--limit <count>", "Maximum hits", "20")
    .action((query: string, commandOptions: { limit?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const limit = Number.parseInt(commandOptions.limit ?? "20", 10);
        const hits = handle.service.searchSessionMessages({
          limit: Number.isFinite(limit) ? limit : 20,
          query
        });
        if (hits.length === 0) {
          console.log(`No session messages matched '${query}'.`);
          return;
        }
        for (const hit of hits) {
          console.log(`${hit.sessionId.slice(0, 8)} | ${hit.sessionTitle} | ${hit.preview.replace(/\s+/gu, " ").trim()}`);
        }
      } finally {
        handle.close();
      }
    });

  sessionCommand
    .command("handoff")
    .description("Bind a runtime session to a gateway external session")
    .requiredOption("--session <session_id>", "Runtime session id")
    .requiredOption("--adapter <adapter_id>", "Gateway adapter id")
    .option("--external-session <id>", "External session id")
    .action((commandOptions: { adapter: string; externalSession?: string; session: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const ownerUserId = process.env.USERNAME ?? process.env.USER ?? "local-user";
        const externalSessionId =
          commandOptions.externalSession ?? `${commandOptions.adapter}:handoff:${commandOptions.session.slice(0, 8)}`;
        const result = handle.service.handoffSession({
          adapterId: commandOptions.adapter,
          externalSessionId,
          ownerUserId,
          runtimeSessionId: commandOptions.session,
          runtimeUserId: `${commandOptions.adapter}:session:${externalSessionId}`,
          source: "cli"
        });
        console.log(`Handoff complete: ${result.runtimeSessionId.slice(0, 8)} -> ${commandOptions.adapter}`);
        console.log(result.resumeHint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Handoff failed: ${message}`);
        process.exitCode = 1;
      } finally {
        handle.close();
      }
    });

  program
    .command("session-api")
    .description("Serve the session HTTP API for dashboards and integrations")
    .command("serve")
    .option("--host <host>", "Bind host", "127.0.0.1")
    .option("--port <port>", "Bind port", "7080")
    .action(async (commandOptions: { host?: string; port?: string }) => {
      const handle = createApplication(process.cwd(), { scheduler: { autoStart: true } });
      const port = Number.parseInt(commandOptions.port ?? "7080", 10);
      try {
        const started = await startSessionApiServer({
          host: commandOptions.host ?? "127.0.0.1",
          port: Number.isFinite(port) ? port : 7080,
          service: handle.service
        });
        console.log(`Session API listening at ${started.url}`);
        await new Promise<void>(() => {});
      } finally {
        handle.close();
      }
    });

  taskCommand.command("list").option("--json", "Print JSON").action((commandOptions: { json?: boolean }) => {
    const handle = createApplication(process.cwd());
    try {
      const tasks = handle.service.listTasks();
      console.log(commandOptions.json === true ? JSON.stringify(tasks, null, 2) : formatTaskList(tasks));
    } finally {
      handle.close();
    }
  });

  taskCommand.command("show").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const result = handle.service.showTask(taskId);
      if (result.task === null) {
        console.error(`Task ${taskId} not found.`);
        process.exitCode = 1;
        return;
      }

      console.log(
        formatTask(result.task, result.toolCalls, result.approvals, result.scheduleRuns, result.inboxItems)
      );
    } finally {
      handle.close();
    }
  });

  taskCommand.command("timeline").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTaskTimeline(handle.service.taskTimeline(taskId)));
    } finally {
      handle.close();
    }
  });

  const traceCommand = program.command("trace").description("Inspect persisted trace data");

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
        const ownerUserId = process.env.USERNAME ?? process.env.USER ?? "local-user";
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
      const handle = createApplication(process.cwd());
      try {
        const query = commandOptions.status === undefined ? undefined : { status: commandOptions.status };
        console.log(formatScheduleList(handle.service.listSchedules(query)));
      } finally {
        handle.close();
      }
    });
  scheduleCommand.command("show").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const schedule = handle.service.showSchedule(scheduleId);
      if (schedule === null) {
        console.error(`Schedule ${scheduleId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatScheduleDetail(schedule));
    } finally {
      handle.close();
    }
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
      const handle = createApplication(process.cwd());
      try {
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
      } finally {
        handle.close();
      }
    });
  scheduleCommand.command("pause").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatScheduleDetail(handle.service.pauseSchedule(scheduleId)));
    } finally {
      handle.close();
    }
  });
  scheduleCommand.command("resume").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatScheduleDetail(handle.service.resumeSchedule(scheduleId)));
    } finally {
      handle.close();
    }
  });
  scheduleCommand.command("run-now").argument("<schedule_id>").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const run = handle.service.runScheduleNow(scheduleId);
      console.log(formatScheduleRunList([run]));
    } finally {
      handle.close();
    }
  });
  scheduleCommand
    .command("runs")
    .argument("<schedule_id>")
    .option("--status <status>", "Filter status")
    .option("--tail <count>", "Number of latest runs", parsePositiveIntegerOption("--tail"), 20)
    .action((scheduleId: string, commandOptions: { status?: string; tail: number }) => {
      const handle = createApplication(process.cwd());
      try {
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
      } finally {
        handle.close();
      }
    });
  scheduleCommand.command("remove").argument("<schedule_id>").description("Archive a schedule").action((scheduleId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatScheduleDetail(handle.service.archiveSchedule(scheduleId)));
    } finally {
      handle.close();
    }
  });
  scheduleCommand.command("status").description("Summarize schedules and queued runs").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatScheduleStatus(handle.service.scheduleStatus()));
    } finally {
      handle.close();
    }
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

  traceCommand
    .argument("[task_id]", "Task identifier")
    .option("--summary", "Print summary instead of full trace")
    .action((taskId: string | undefined, commandOptions: { summary?: boolean }) => {
    if (taskId === undefined) {
      console.error("Task id is required.");
      process.exitCode = 1;
      return;
    }

    const handle = createApplication(process.cwd());
    try {
      const trace = handle.service.traceTask(taskId);
      console.log(commandOptions.summary ? summarizeTrace(trace) : formatTrace(trace));
    } finally {
      handle.close();
    }
  });

  traceCommand.command("context").argument("<task_id>", "Task identifier").action((taskId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatTraceContextDebug(handle.service.traceTaskContext(taskId)));
    } finally {
      handle.close();
    }
  });

  program
    .command("audit")
    .argument("<task_id>", "Task identifier")
    .option("--summary", "Print summary instead of raw entries")
    .action((taskId: string, commandOptions: { summary?: boolean }) => {
      const handle = createApplication(process.cwd());
      try {
        const audit = handle.service.auditTask(taskId);
        console.log(commandOptions.summary ? summarizeAudit(audit) : formatAuditLog(audit));
      } finally {
        handle.close();
      }
    });

  const inboxCommand = program.command("inbox").description("Inspect collaboration inbox items");
  inboxCommand
    .option("--user <user>", "Filter by runtime user id")
    .option("--status <status>", "Filter status: pending | seen | done | dismissed", "pending")
    .option(
      "--category <category>",
      "Filter category: task_completed | task_failed | task_blocked | decision_requested | approval_requested | memory_suggestion | skill_promotion"
    )
    .option("--limit <count>", "Limit entries", parsePositiveIntegerOption("--limit"), 50)
    .action((commandOptions: InboxListOptions) => {
      listInboxItems(commandOptions);
    });
  inboxCommand
    .command("list")
    .option("--user <user>", "Filter by runtime user id")
    .option("--status <status>", "Filter status: pending | seen | done | dismissed", "pending")
    .option(
      "--category <category>",
      "Filter category: task_completed | task_failed | task_blocked | decision_requested | approval_requested | memory_suggestion | skill_promotion"
    )
    .option("--limit <count>", "Limit entries", parsePositiveIntegerOption("--limit"), 50)
    .action((commandOptions: InboxListOptions) => {
      listInboxItems(commandOptions);
    });
  inboxCommand.command("show").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const item = handle.service.showInboxItem(inboxId);
      if (item === null) {
        console.error(`Inbox item ${inboxId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatInboxDetail(item));
    } finally {
      handle.close();
    }
  });
  inboxCommand.command("done").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const reviewer = process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
      console.log(formatInboxDetail(handle.service.markInboxDone(inboxId, reviewer)));
    } finally {
      handle.close();
    }
  });
  inboxCommand.command("dismiss").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatInboxDetail(handle.service.markInboxDismissed(inboxId)));
    } finally {
      handle.close();
    }
  });

  const commitmentsCommand = program.command("commitments").description("Manage session commitments");
  commitmentsCommand
    .command("list")
    .option("--session <session_id>", "Session id")
    .option("--status <status>", "Filter status")
    .action((commandOptions: { session?: string; status?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const list = handle.service.listCommitments({
          ...(commandOptions.session !== undefined ? { sessionId: commandOptions.session } : {}),
          ...(commandOptions.status !== undefined ? { status: commandOptions.status as CommitmentRecord["status"] } : {})
        });
        console.log(formatCommitmentList(list));
      } finally {
        handle.close();
      }
    });
  commitmentsCommand.command("show").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const item = handle.service.showCommitment(commitmentId);
      if (item === null) {
        console.error(`Commitment ${commitmentId} not found.`);
        process.exitCode = 1;
        return;
      }
      console.log(formatCommitmentDetail(item));
    } finally {
      handle.close();
    }
  });
  commitmentsCommand
    .command("create")
    .requiredOption("--session <session_id>", "Session id")
    .requiredOption("--title <title>", "Commitment title")
    .option("--summary <summary>", "Commitment summary", "")
    .action((commandOptions: { session: string; title: string; summary?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const ownerUserId = process.env.USERNAME ?? process.env.USER ?? "local-user";
        const created = handle.service.createCommitment({
          ownerUserId,
          source: "manual",
          summary: commandOptions.summary ?? "",
          sessionId: commandOptions.session,
          title: commandOptions.title
        });
        console.log(formatCommitmentDetail(created));
      } finally {
        handle.close();
      }
    });
  commitmentsCommand
    .command("block")
    .argument("<commitment_id>")
    .requiredOption("--reason <reason>")
    .action((commitmentId: string, commandOptions: { reason: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatCommitmentDetail(handle.service.blockCommitment(commitmentId, commandOptions.reason)));
      } finally {
        handle.close();
      }
    });
  commitmentsCommand.command("unblock").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCommitmentDetail(handle.service.unblockCommitment(commitmentId)));
    } finally {
      handle.close();
    }
  });
  commitmentsCommand.command("complete").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCommitmentDetail(handle.service.completeCommitment(commitmentId)));
    } finally {
      handle.close();
    }
  });
  commitmentsCommand.command("cancel").argument("<commitment_id>").action((commitmentId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCommitmentDetail(handle.service.cancelCommitment(commitmentId)));
    } finally {
      handle.close();
    }
  });

  const nextCommand = program.command("next").description("Manage next actions");
  nextCommand
    .command("list")
    .option("--session <session_id>", "Session id")
    .action((commandOptions: { session?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const list = handle.service.listNextActions(
          commandOptions.session !== undefined ? { sessionId: commandOptions.session } : {}
        );
        console.log(formatNextActionList(list));
      } finally {
        handle.close();
      }
    });
  nextCommand
    .command("add")
    .requiredOption("--session <session_id>", "Session id")
    .requiredOption("--title <title>", "Action title")
    .option("--commitment <commitment_id>", "Related commitment id")
    .action((commandOptions: { session: string; title: string; commitment?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const created = handle.service.appendNextAction({
          commitmentId: commandOptions.commitment ?? null,
          source: "manual",
          status: "pending",
          sessionId: commandOptions.session,
          title: commandOptions.title
        });
        console.log(formatNextActionList([created]));
      } finally {
        handle.close();
      }
    });
  nextCommand.command("done").argument("<next_action_id>").action((nextActionId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatNextActionList([handle.service.markNextActionDone(nextActionId)]));
    } finally {
      handle.close();
    }
  });
  nextCommand
    .command("block")
    .argument("<next_action_id>")
    .requiredOption("--reason <reason>")
    .action((nextActionId: string, commandOptions: { reason: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatNextActionList([handle.service.blockNextAction(nextActionId, commandOptions.reason)]));
      } finally {
        handle.close();
      }
    });
  nextCommand.command("unblock").argument("<next_action_id>").action((nextActionId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatNextActionList([handle.service.unblockNextAction(nextActionId)]));
    } finally {
      handle.close();
    }
  });
  nextCommand
    .command("resume")
    .option("--cwd <path>", "Working directory", process.cwd())
    .action(async (commandOptions: { cwd: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const result = await handle.service.continueLatest(undefined, { cwd: commandOptions.cwd });
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Session ID: ${result.task.sessionId ?? "-"}`);
        console.log(`Status: ${result.task.status}`);
        if (result.output !== null) {
          console.log(result.output);
        }
      } finally {
        handle.close();
      }
    });

  const approveCommand = program.command("approve").description("Inspect and resolve approvals");

  approveCommand.command("pending").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatApprovalList(handle.service.listPendingApprovals()));
    } finally {
      handle.close();
    }
  });

  approveCommand
    .command("allow")
    .argument("<approval_id>", "Approval identifier")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--scope <scope>", "Allow scope: once | session | always", "once")
    .action(async (approvalId: string, commandOptions: { reviewer?: string; scope?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const reviewerId =
          commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
        const scope = parseApprovalAllowScope(commandOptions.scope);
        const result = await handle.service.resolveApproval(
          approvalId,
          "allow",
          reviewerId,
          scope
        );
        console.log(`Approval: ${result.approval.approvalId} ${result.approval.status}`);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
        if (result.error !== undefined) {
          console.log(`Error: ${result.error.code} ${result.error.message}`);
        }
        if (result.output !== null) {
          console.log(result.output);
        }
      } finally {
        handle.close();
      }
    });

  approveCommand
    .command("deny")
    .argument("<approval_id>", "Approval identifier")
    .option("--reviewer <reviewer>", "Reviewer id")
    .action(async (approvalId: string, commandOptions: { reviewer?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const reviewerId =
          commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
        const result = await handle.service.resolveApproval(approvalId, "deny", reviewerId);
        console.log(`Approval: ${result.approval.approvalId} ${result.approval.status}`);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
      } finally {
        handle.close();
      }
    });

  program
    .command("config")
    .description("Configuration and environment checks")
    .command("doctor")
    .action(async () => {
      const handle = createApplication(process.cwd());
      try {
        const migration = await handle.service.migrateLegacyTranscripts();
        if (migration.migratedFiles > 0 || migration.skippedFiles > 0) {
          console.log(
            `Transcript migration: migrated=${migration.migratedFiles} skipped=${migration.skippedFiles}`
          );
        }
        console.log(formatDoctorReport(await handle.service.configDoctor()));
      } finally {
        handle.close();
      }
    });

  program
    .command("doctor")
    .description("Run configuration and environment checks")
    .action(async () => {
      const handle = createApplication(process.cwd());
      try {
        const migration = await handle.service.migrateLegacyTranscripts();
        if (migration.migratedFiles > 0 || migration.skippedFiles > 0) {
          console.log(
            `Transcript migration: migrated=${migration.migratedFiles} skipped=${migration.skippedFiles}`
          );
        }
        console.log(formatDoctorReport(await handle.service.configDoctor()));
      } finally {
        handle.close();
      }
    });

  program
    .command("init")
    .description("Initialize .auto-talon workspace files")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--yes", "Create defaults non-interactively")
    .action((commandOptions: { cwd: string }) => {
      const result = initializeWorkspaceFiles(commandOptions.cwd);
      console.log(`Initialized: ${result.workspaceConfigDir}`);
      console.log(
        result.createdFiles.length === 0
          ? "No new files created."
          : `Created files:\n${result.createdFiles.join("\n")}`
      );
    });

  program
    .command("sandbox")
    .description("Show the resolved sandbox configuration")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action((commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const sandbox = handle.config.sandbox;
        console.log(`Mode: ${sandbox.mode}`);
        console.log(`Profile: ${sandbox.profileName ?? "(default)"}`);
        console.log(`Source: ${sandbox.configSource}`);
        console.log(`Workspace: ${sandbox.workspaceRoot}`);
        console.log(`Write Roots: ${sandbox.writeRoots.join(", ")}`);
        console.log(`Read Roots: ${sandbox.readRoots.join(", ")}`);
      } finally {
        handle.close();
      }
    });

  const skillsCommand = program.command("skills").description("Inspect and manage procedural skills");

  skillsCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillList(handle.service.listSkills()));
    } finally {
      handle.close();
    }
  });

  skillsCommand
    .command("view")
    .argument("<skill_id>", "Skill identifier")
    .option("--with <kinds>", "Comma-separated attachment kinds: references,templates,scripts,assets")
    .action((skillId: string, commandOptions: { with?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const attachmentKinds = parseAttachmentKinds(commandOptions.with);
        const skill = handle.service.viewSkill(skillId, attachmentKinds);
        console.log(formatSkillView(skill));
        if (skill === null) {
          process.exitCode = 1;
        }
      } finally {
        handle.close();
      }
    });

  skillsCommand.command("enable").argument("<skill_id>", "Skill identifier").action((skillId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillList(handle.service.enableSkill(skillId)));
    } finally {
      handle.close();
    }
  });

  skillsCommand.command("disable").argument("<skill_id>", "Skill identifier").action((skillId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillList(handle.service.disableSkill(skillId)));
    } finally {
      handle.close();
    }
  });

  skillsCommand
    .command("draft")
    .requiredOption("--from-experience <experience_id>", "Accepted or promoted experience id")
    .action((commandOptions: { fromExperience: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatSkillDraft(handle.service.createSkillDraftFromExperience(commandOptions.fromExperience)));
      } finally {
        handle.close();
      }
    });

  skillsCommand.command("promote").argument("<draft_id>", "Skill draft identifier").action((draftId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatSkillDraft(handle.service.promoteSkillDraft(draftId)));
    } finally {
      handle.close();
    }
  });

  const registerSkillRollbackCommand = (command: ReturnType<typeof program.command>) => {
    command
      .command("rollback")
      .argument("<skill_id>", "Skill identifier (for example: project:namespace/name)")
      .requiredOption("--reason <text>", "Rollback reason for audit trail")
      .action((skillId: string, commandOptions: { reason: string }) => {
        const handle = createApplication(process.cwd());
        try {
          const rollback = handle.service.rollbackSkillPromotion(skillId, commandOptions.reason);
          console.log(
            `Rolled back ${skillId} to ${rollback.version} (from ${rollback.previousVersion ?? "unknown"})`
          );
        } finally {
          handle.close();
        }
      });
  };
  registerSkillRollbackCommand(skillsCommand);
  registerSkillRollbackCommand(program.command("skill").description("Singular alias for skills"));

  const toolsCommand = program.command("tools").description("Inspect and manage runtime tools");

  toolsCommand.command("list").action(() => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatToolList(handle.service.listTools()));
    } finally {
      handle.close();
    }
  });

  toolsCommand.command("enable").argument("<tool_name>", "Tool name").action((toolName: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatToolList(handle.service.enableTool(toolName)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      handle.close();
    }
  });

  toolsCommand.command("disable").argument("<tool_name>", "Tool name").action((toolName: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatToolList(handle.service.disableTool(toolName)));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      handle.close();
    }
  });

  const workspaceCommand = program.command("workspace").description("Inspect workspace coding context");

  workspaceCommand
    .command("map")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      printWorkspaceMap(commandOptions.cwd);
    });

  workspaceCommand
    .command("changes")
    .description("Show git status and diff summary for the current workspace")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      console.log(formatWorkspaceChanges(commandOptions.cwd));
    });

  program
    .command("repo")
    .description("Deprecated alias for workspace")
    .command("map")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action((commandOptions: { cwd: string }) => {
      console.warn("Warning: `talon repo map` is deprecated; use `talon workspace map`.");
      printWorkspaceMap(commandOptions.cwd);
    });

  workspaceCommand
    .command("rollback")
    .description("Rollback a file write checkpoint")
    .argument("<artifact_id>", "Rollback artifact id or last")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (artifactId: string, commandOptions: { cwd: string }) => {
      const handle = createApplication(commandOptions.cwd);
      try {
        const result = await handle.service.rollbackFileArtifact(artifactId);
        console.log(
          result.deleted
            ? `Rolled back by deleting ${result.path}`
            : `Rolled back by restoring ${result.path}`
        );
        console.log(`Artifact: ${result.artifact.artifactId}`);
      } finally {
        handle.close();
      }
    });

  const providerCommand = program.command("provider").description("Configure, inspect, and test providers");

  providerCommand.command("list").option("--json", "Print JSON").action((commandOptions: { json?: boolean }) => {
    const handle = createApplication(process.cwd());
    try {
      const providers = handle.service.listProviders();
      console.log(commandOptions.json === true
        ? JSON.stringify(providers, null, 2)
        : formatProviderCatalog(handle.service.currentProvider().name, providers));
    } finally {
      handle.close();
    }
  });

  const printCurrentProvider = (): void => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatCurrentProvider(handle.service.currentProvider()));
    } finally {
      handle.close();
    }
  };

  providerCommand.command("current").description("Show the active provider").action(printCurrentProvider);
  providerCommand.command("status").description("Show provider setup status").action(printCurrentProvider);

  providerCommand
    .command("setup")
    .description("Configure a provider in reusable user config")
    .argument("<provider>", "Provider name; provider:model also sets the model")
    .option("--api-key <key>", "API key to store in provider config")
    .option("--base-url <url>", "Provider base URL")
    .option("--model <model>", "Model name")
    .option("--timeout-ms <number>", "Request timeout in milliseconds", parsePositiveIntegerOption("--timeout-ms"))
    .option("--stream-idle-timeout-ms <number>", "Streaming idle timeout in milliseconds", parsePositiveIntegerOption("--stream-idle-timeout-ms"))
    .option("--max-retries <number>", "Maximum provider retries", parseNonNegativeIntegerOption("--max-retries"))
    .option("--workspace", "Write this workspace config instead of user config")
    .action((provider: string, commandOptions: ProviderSetupCommandOptions) => {
      const result = setupProviderConfig(provider, {
        ...(commandOptions.apiKey !== undefined ? { apiKey: commandOptions.apiKey } : {}),
        ...(commandOptions.baseUrl !== undefined ? { baseUrl: commandOptions.baseUrl } : {}),
        ...(commandOptions.maxRetries !== undefined ? { maxRetries: commandOptions.maxRetries } : {}),
        ...(commandOptions.model !== undefined ? { model: commandOptions.model } : {}),
        ...(commandOptions.streamIdleTimeoutMs !== undefined
          ? { streamIdleTimeoutMs: commandOptions.streamIdleTimeoutMs }
          : {}),
        ...(commandOptions.timeoutMs !== undefined ? { timeoutMs: commandOptions.timeoutMs } : {}),
        ...resolveProviderConfigTarget(commandOptions.workspace === true)
      });
      console.log(formatProviderConfigWrite("Configured", result));
    });

  providerCommand
    .command("use")
    .description("Select a provider in reusable user config")
    .argument("<provider>", "Provider name; provider:model also sets the model")
    .option("--workspace", "Write this workspace config instead of user config")
    .action((provider: string, commandOptions: ProviderUseCommandOptions) => {
      const result = useProviderConfig(provider, resolveProviderConfigTarget(commandOptions.workspace === true));
      console.log(formatProviderConfigWrite("Selected", result));
    });

  providerCommand
    .command("promote")
    .description("Save the current effective provider as the user default")
    .action(() => {
      const handle = createApplication(process.cwd());
      try {
        const result = promoteProviderConfig(handle.service.currentProvider());
        console.log(formatProviderConfigWrite("Promoted", result));
      } finally {
        handle.close();
      }
    });

  providerCommand.command("test").action(async () => {
    const handle = createApplication(process.cwd());
    try {
      const report = await handle.service.testCurrentProvider();
      console.log(formatProviderHealth(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  providerCommand.command("smoke").description("Run a synthetic post-tool provider turn").action(async () => {
    const handle = createApplication(process.cwd());
    try {
      const report = await handle.service.smokeCurrentProvider();
      console.log(formatProviderSmoke(report));
      if (!report.ok) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  providerCommand
    .command("stats")
    .option("--by <groupBy>", "Group by: provider | session | task | mode", "provider")
    .action((commandOptions: { by: "provider" | "session" | "task" | "mode" }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatProviderStats(handle.service.providerStats(commandOptions.by)));
      } finally {
        handle.close();
      }
    });

  providerCommand
    .command("route")
    .requiredOption("--mode <mode>", "cheap_first | balanced | quality_first")
    .action((commandOptions: { mode: "cheap_first" | "balanced" | "quality_first" }) => {
      const handle = createApplication(process.cwd());
      try {
        handle.service.setRoutingMode(commandOptions.mode);
        console.log(`Routing mode updated: ${commandOptions.mode}`);
      } finally {
        handle.close();
      }
    });

  const budgetCommand = program.command("budget").description("Inspect runtime budget usage");
  budgetCommand
    .command("show")
    .option("--task <taskId>", "Task id")
    .option("--session <sessionId>", "Session id")
    .action((commandOptions: { task?: string; session?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        if (commandOptions.task !== undefined) {
          console.log(JSON.stringify(handle.service.budgetReport("task", commandOptions.task), null, 2));
          return;
        }
        if (commandOptions.session !== undefined) {
          console.log(JSON.stringify(handle.service.budgetReport("session", commandOptions.session), null, 2));
          return;
        }
        console.log("Provide --task <id> or --session <id>.");
      } finally {
        handle.close();
      }
    });

  const smokeCommand = program.command("smoke").description("Run fixed runtime smoke tasks");

  program
    .command("replay")
    .argument("<task_id>", "Task identifier")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--from-iteration <number>", "Replay starting from this iteration", parsePositiveIntegerOption("--from-iteration"), 1)
    .option("--provider <mode>", "Replay provider mode: current | mock", "current")
    .option("--dry-run", "Show replay parameters without executing")
    .action(
      async (
        taskId: string,
        commandOptions: {
          cwd: string;
          dryRun?: boolean;
          fromIteration: number;
          provider: "current" | "mock";
        }
      ) => {
        if (commandOptions.dryRun === true) {
          console.log(
            `Replay dry-run: task=${taskId} cwd=${commandOptions.cwd} fromIteration=${commandOptions.fromIteration} provider=${commandOptions.provider}`
          );
          return;
        }
        const report = await replayTaskById(taskId, {
          cwd: commandOptions.cwd,
          fromIteration: commandOptions.fromIteration,
          providerMode: commandOptions.provider
        });
        console.log(formatReplayReport(report));
        if (report.replayTask.status === "failed" || report.replayTask.status === "cancelled") {
          process.exitCode = 1;
        }
      }
    );

  const evalCommand = program.command("eval").description("Run minimal eval and beta readiness checks");

  evalCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--json", "Print JSON instead of text")
    .option("--explain", "Append plain-language explanation")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        explain?: boolean;
        json?: boolean;
        output?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        const report = await runEvalReport({
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        let output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatEvalReport(report);
        if (commandOptions.explain === true && commandOptions.json !== true) {
          output = `${output}\nExplanation: The suite validates repeatable core workflows and flags provider/policy regressions.`;
        }
        if (commandOptions.output !== undefined) {
          writeFileSync(commandOptions.output, `${output}\n`, "utf8");
        } else {
          console.log(output);
        }
        if (report.successRate < 1) {
          process.exitCode = 1;
        }
      }
    );

  evalCommand
    .command("smoke")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(
      async (commandOptions: SmokeCommandOptions) => {
        console.warn("Warning: `talon eval smoke` is a compatibility alias; use `talon smoke run`.");
        await runSmokeCommand(commandOptions);
      }
    );

  evalCommand
    .command("coding")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated coding task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--min-success-rate <number>", "Minimum acceptable coding task success rate", parseRatioOption("--min-success-rate"), 0.8)
    .option("--json", "Print JSON instead of text")
    .option("--output <path>", "Write the report to a file")
    .action(
      async (commandOptions: {
        fixture?: string;
        json?: boolean;
        minSuccessRate: number;
        output?: string;
        provider: SupportedProviderName | "scripted-smoke";
        tasks?: string;
      }) => {
        const report = await runCodingEvalReport({
          ...(commandOptions.fixture !== undefined
            ? { fixturePath: commandOptions.fixture }
            : {}),
          minimumSuccessRate: commandOptions.minSuccessRate,
          providerName: commandOptions.provider,
          taskIds:
            commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
        });
        const output = commandOptions.json === true
          ? JSON.stringify(report, null, 2)
          : formatCodingEvalReport(report);
        if (commandOptions.output !== undefined) {
          writeFileSync(commandOptions.output, `${output}\n`, "utf8");
        } else {
          console.log(output);
        }
        if (!report.betaGate.passed) {
          process.exitCode = 1;
        }
      }
    );

  const releaseCommand = program.command("release").description("Release readiness checks");
  releaseCommand
    .command("check")
    .option("--provider <provider>", "Provider to use for eval checks", "scripted-smoke")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .action(async (commandOptions: { cwd: string; provider: SupportedProviderName | "scripted-smoke" }) => {
      const report = await runReleaseChecklist({
        cwd: commandOptions.cwd,
        provider: commandOptions.provider
      });
      console.log(formatReleaseChecklistReport(report));
      if (!report.allPassed) {
        process.exitCode = 1;
      }
    });

  evalCommand
    .command("beta")
    .option("--provider <provider>", "Provider to use for sample eval: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--min-success-rate <number>", "Minimum acceptable task success rate", parseRatioOption("--min-success-rate"), 0.8)
    .action(
      async (commandOptions: {
        minSuccessRate: number;
        provider: SupportedProviderName | "scripted-smoke";
      }) => {
        const report = await runBetaReadinessCheck({
          minimumSuccessRate: commandOptions.minSuccessRate,
          providerName: commandOptions.provider
        });
        console.log(formatBetaReadinessReport(report));
        if (!report.allPassed) {
          process.exitCode = 1;
        }
      }
    );

  smokeCommand
    .command("run")
    .option("--provider <provider>", "Provider to use: scripted-smoke or any registered provider", "scripted-smoke")
    .option("--tasks <taskIds>", "Comma-separated smoke task ids")
    .option("--fixture <path>", "Custom fixture file path")
    .option("--no-auto-approve", "Do not auto-resolve approvals during smoke runs")
    .action(async (commandOptions: SmokeCommandOptions) => {
      await runSmokeCommand(commandOptions);
    });

  const memoryCommand = program.command("memory").description("Inspect governed memories");

  memoryCommand
    .command("list")
    .option("--scope <scope>", "Filter scope: profile | project | working | experience_ref | skill_ref")
    .action((commandOptions: { scope?: "profile" | "project" | "working" | "experience_ref" | "skill_ref" | "session" | "agent" }) => {
      const handle = createApplication(process.cwd());
      try {
        const memories = handle.service.listMemories();
        const scope =
          commandOptions.scope === undefined ? undefined : normalizeMemoryScope(commandOptions.scope);
        console.log(
          formatMemoryList(
            scope === undefined ? memories : memories.filter((memory) => memory.scope === scope)
          )
        );
      } finally {
        handle.close();
      }
    });

  memoryCommand.command("guide").description("Explain memory layer semantics").action(() => {
    console.log(formatMemoryGuide());
  });

  memoryCommand
    .command("add")
    .argument("<scope>", "Memory scope: profile | project")
    .argument("<text>", "Memory text")
    .option("--cwd <path>", "Workspace path for project scope", process.cwd())
    .option("--profile <profile>", "Agent profile for profile scope", "executor")
    .option("--user <user>", "User id for profile scope")
    .option("--reviewer <reviewer>", "Reviewer id")
    .action(
      (
        scope: "profile" | "project" | "working",
        text: string,
        commandOptions: { cwd: string; profile: string; reviewer?: string; user?: string }
      ) => {
        const handle = createApplication(commandOptions.cwd);
        try {
          if (scope !== "profile" && scope !== "project") {
            throw new Error("Memory add only supports profile and project scopes.");
          }
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const userId = commandOptions.user ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
          const memory = handle.service.addMemory({
            content: text,
            cwd: commandOptions.cwd,
            profileId: commandOptions.profile,
            reviewerId: reviewer,
            scope,
            userId
          });
          console.log(formatMemoryList([memory]));
        } finally {
          handle.close();
        }
      }
    );

  memoryCommand
    .command("forget")
    .argument("<memory_id>", "Memory identifier")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Forget note", "manual memory forget")
    .action((memoryId: string, commandOptions: { note: string; reviewer?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const reviewer =
          commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
        console.log(formatMemoryList([handle.service.forgetMemory(memoryId, reviewer, commandOptions.note)]));
      } finally {
        handle.close();
      }
    });

  memoryCommand
    .command("why")
    .option("--task <taskId>", "Task id to inspect")
    .option("--memory <memoryId>", "Filter to one memory id")
    .action((commandOptions: { memory?: string; task?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        if (commandOptions.task === undefined) {
          throw new Error("Provide --task <taskId>.");
        }
        console.log(
          formatMemoryRecallExplanation(
            handle.service.explainMemoryRecall(commandOptions.task, commandOptions.memory)
          )
        );
      } finally {
        handle.close();
      }
    });

  memoryCommand
    .command("search")
    .argument("<query>", "Session memory search query")
    .option("--session <sessionId>", "Search within specific session")
    .option("--global", "Search across all sessions")
    .option("--exclude-session <sessionId>", "Exclude one session from global search")
    .option("--limit <number>", "Max hit count", parsePositiveIntegerOption("--limit"), 5)
    .action(
      (
        query: string,
        commandOptions: {
          session?: string;
          global?: boolean;
          excludeSession?: string;
          limit: number;
        }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          if (commandOptions.global !== true && commandOptions.session === undefined) {
            throw new Error("Provide --session <sessionId> or use --global.");
          }
          if (commandOptions.global === true && commandOptions.session !== undefined) {
            throw new Error("Use either --global or --session, not both.");
          }
          const hits =
            commandOptions.global === true
              ? handle.service.searchSessionSummaries({
                  excludeSessionId: commandOptions.excludeSession ?? null,
                  limit: commandOptions.limit,
                  query
                })
              : handle.service.searchSessionSummaries({
                  limit: commandOptions.limit,
                  query,
                  sessionId: commandOptions.session ?? ""
                });
          console.log(formatSessionSummarySearchHits(hits));
        } finally {
          handle.close();
        }
      }
    );

  memoryCommand
    .command("show")
    .argument("<scope>", "Memory scope: profile | project | working | experience_ref | skill_ref")
    .option("--scope-key <key>", "Explicit scope key")
    .option("--task-id <taskId>", "Task id for session scope")
    .option("--cwd <path>", "Workspace path for project scope", process.cwd())
    .option("--profile <profile>", "Agent profile for agent scope", "executor")
    .option("--user <user>", "User id for agent scope")
    .action(
      (
        scope: "profile" | "project" | "working" | "experience_ref" | "skill_ref" | "session" | "agent",
        commandOptions: {
          scopeKey?: string;
          taskId?: string;
          cwd: string;
          profile: string;
          user?: string;
        }
      ) => {
        const handle = createApplication(commandOptions.cwd);
        try {
          const resolvedScope = normalizeMemoryScope(scope);
          const scopeKey = resolveScopeKey(resolvedScope, {
            cwd: commandOptions.cwd,
            profile: commandOptions.profile,
            scopeKey: commandOptions.scopeKey,
            taskId: commandOptions.taskId,
            user: commandOptions.user
          });
          if (resolvedScope === "experience_ref") {
            console.log(
              formatExperienceList(
                handle.service.listExperiences({
                  scopeKey
                })
              )
            );
            return;
          }
          if (resolvedScope === "skill_ref") {
            console.log(formatSkillList(handle.service.listSkills()));
            return;
          }
          const result = handle.service.showMemoryScope(resolvedScope, scopeKey);
          console.log(formatMemoryScope(resolvedScope, scopeKey, result.memories, result.snapshots));
        } finally {
          handle.close();
        }
      }
    );

  const snapshotCommand = memoryCommand.command("snapshot").description("Manage memory snapshots");

  snapshotCommand
    .command("create")
    .argument("<scope>", "Memory scope: profile | project")
    .option("--label <label>", "Snapshot label", "manual-snapshot")
    .option("--scope-key <key>", "Explicit scope key")
    .option("--task-id <taskId>", "Task id for session scope")
    .option("--cwd <path>", "Workspace path for project scope", process.cwd())
    .option("--profile <profile>", "Agent profile for agent scope", "executor")
    .option("--user <user>", "User id for agent scope")
    .option("--reviewer <reviewer>", "Snapshot creator id")
    .action(
      (
        scope: "profile" | "project" | "session" | "agent",
        commandOptions: {
          cwd: string;
          label: string;
          profile: string;
          reviewer?: string;
          scopeKey?: string;
          taskId?: string;
          user?: string;
        }
      ) => {
        const handle = createApplication(commandOptions.cwd);
        try {
          const resolvedScope = normalizeMemoryScope(scope);
          if (resolvedScope !== "profile" && resolvedScope !== "project") {
            throw new Error("Snapshot create only supports profile and project scopes.");
          }
          const scopeKey = resolveScopeKey(resolvedScope, {
            cwd: commandOptions.cwd,
            profile: commandOptions.profile,
            scopeKey: commandOptions.scopeKey,
            taskId: commandOptions.taskId,
            user: commandOptions.user
          });
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const snapshot = handle.service.createMemorySnapshot(
            resolvedScope,
            scopeKey,
            commandOptions.label,
            reviewer
          );
          console.log(formatSnapshot(snapshot));
        } finally {
          handle.close();
        }
      }
    );

  memoryCommand
    .command("review")
    .argument("<memory_id>", "Memory identifier")
    .argument("<status>", "verified | rejected | stale")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Review note", "manual memory review")
    .action(
      (
        memoryId: string,
        status: "verified" | "rejected" | "stale",
        commandOptions: { note: string; reviewer?: string }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const reviewed = handle.service.reviewMemory(
            memoryId,
            status,
            reviewer,
            commandOptions.note
          );
          console.log(formatMemoryList([reviewed]));
        } finally {
          handle.close();
        }
      }
    );

  const memoryReviewCommand = memoryCommand.command("review-queue").description("Review memory suggestions in inbox");

  memoryReviewCommand
    .command("list")
    .option("--user <user>", "Filter by runtime user id")
    .option("--status <status>", "Filter status: pending | seen | done | dismissed", "pending")
    .option("--limit <count>", "Limit entries", parsePositiveIntegerOption("--limit"), 20)
    .action((commandOptions: { limit?: number; status?: InboxListOptions["status"]; user?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(
          formatMemorySuggestionQueue(
            handle.service.listMemorySuggestions({
              ...(commandOptions.limit !== undefined
                ? { limit: commandOptions.limit }
                : {}),
              ...(commandOptions.status !== undefined ? { status: commandOptions.status } : {}),
              ...(commandOptions.user !== undefined ? { userId: commandOptions.user } : {})
            })
          )
        );
      } finally {
        handle.close();
      }
    });

  memoryReviewCommand.command("accept").argument("<inbox_id>").option("--reviewer <reviewer>", "Reviewer id").action(
    (inboxId: string, commandOptions: { reviewer?: string }) => {
      const handle = createApplication(process.cwd());
      try {
        const reviewer =
          commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
        const accepted = handle.service.acceptMemorySuggestion(inboxId, reviewer);
        console.log(formatInboxDetail(accepted.inboxItem));
        if (accepted.memory !== null) {
          console.log(formatMemoryList([accepted.memory]));
        }
      } finally {
        handle.close();
      }
    }
  );

  memoryReviewCommand.command("dismiss").argument("<inbox_id>").action((inboxId: string) => {
    const handle = createApplication(process.cwd());
    try {
      console.log(formatInboxDetail(handle.service.dismissMemorySuggestion(inboxId)));
    } finally {
      handle.close();
    }
  });

  const experienceCommand = program.command("experience").description("Inspect and review experience assets");

  experienceCommand
    .command("list")
    .option("--type <type>", "Experience type")
    .option("--source <sourceType>", "Experience source type")
    .option("--status <status>", "Experience status")
    .option("--min-value <score>", "Minimum value score", parseNonNegativeNumberOption("--min-value"))
    .option("--task-id <taskId>", "Task id filter")
    .option("--reviewer <reviewerId>", "Reviewer id filter")
    .option("--scope <scope>", "Scope filter")
    .option("--scope-key <scopeKey>", "Scope key filter")
    .option("--limit <number>", "Maximum records", parsePositiveIntegerOption("--limit"))
    .action((commandOptions: ExperienceFilterOptions) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatExperienceList(handle.service.listExperiences(toExperienceQuery(commandOptions))));
      } finally {
        handle.close();
      }
    });

  experienceCommand.command("show").argument("<experience_id>", "Experience identifier").action((experienceId: string) => {
    const handle = createApplication(process.cwd());
    try {
      const experience = handle.service.showExperience(experienceId);
      console.log(formatExperienceDetail(experience));
      if (experience === null) {
        process.exitCode = 1;
      }
    } finally {
      handle.close();
    }
  });

  experienceCommand
    .command("review")
    .argument("<experience_id>", "Experience identifier")
    .argument("<status>", "accepted | rejected | stale")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Review note", "manual experience review")
    .option("--value <score>", "Override value score", parseNonNegativeNumberOption("--value"))
    .action(
      (
        experienceId: string,
        status: "accepted" | "rejected" | "stale",
        commandOptions: { note: string; reviewer?: string; value?: number }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const reviewed = handle.service.reviewExperience({
            experienceId,
            note: commandOptions.note,
            reviewerId: reviewer,
            status,
            ...(commandOptions.value !== undefined ? { valueScore: commandOptions.value } : {})
          });
          console.log(formatExperienceList([reviewed]));
        } finally {
          handle.close();
        }
      }
    );

  experienceCommand
    .command("promote")
    .argument("<experience_id>", "Experience identifier")
    .argument("<target>", "project_memory | profile_memory | skill_candidate")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Promotion note", "manual experience promotion")
    .action(
      (
        experienceId: string,
        target: "project_memory" | "profile_memory" | "agent_memory" | "skill_candidate",
        commandOptions: { note: string; reviewer?: string }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer =
            commandOptions.reviewer ?? process.env.USERNAME ?? process.env.USER ?? "local-reviewer";
          const result = handle.service.promoteExperience({
            experienceId,
            note: commandOptions.note,
            reviewerId: reviewer,
            target
          });
          console.log(formatExperienceList([result.experience]));
          console.log(`Promoted Memory: ${result.memory?.memoryId ?? "-"}`);
        } finally {
          handle.close();
        }
      }
    );

  experienceCommand
    .command("search")
    .argument("<query>", "Keyword query")
    .option("--type <type>", "Experience type")
    .option("--source <sourceType>", "Experience source type")
    .option("--status <status>", "Experience status")
    .option("--min-value <score>", "Minimum value score", parseNonNegativeNumberOption("--min-value"))
    .option("--task-id <taskId>", "Task id filter")
    .option("--reviewer <reviewerId>", "Reviewer id filter")
    .option("--scope <scope>", "Scope filter")
    .option("--scope-key <scopeKey>", "Scope key filter")
    .option("--limit <number>", "Maximum records", parsePositiveIntegerOption("--limit"))
    .action((query: string, commandOptions: ExperienceFilterOptions) => {
      const handle = createApplication(process.cwd());
      try {
        console.log(formatExperienceSearch(handle.service.searchExperiences(query, toExperienceQuery(commandOptions))));
      } finally {
        handle.close();
      }
    });

  program
    .command("tui")
    .description("Open personal assistant terminal UI")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--mode <mode>", "UI mode: chat | ops", "chat")
    .option("--continue", "Resume the latest SQLite session")
    .option("-c", "Alias for --continue")
    .option("--resume <sessionId>", "Resume a session by runtime session_id")
    .action(async (commandOptions: SandboxCommandOptions & { continue?: boolean; c?: boolean; mode?: string; resume?: string }) => {
      if (commandOptions.mode === "ops" || commandOptions.mode === "dashboard") {
        await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
        return;
      }
      await startTui({
        cwd: commandOptions.cwd,
        sandbox: resolveSandboxCliOptions(commandOptions),
        ...(commandOptions.continue === true || commandOptions.c === true ? { continueLatest: true } : {}),
        ...(commandOptions.resume !== undefined ? { resumeSessionId: commandOptions.resume } : {})
      });
    });

  program
    .command("ops")
    .description("Open ops terminal UI for runtime observability and approvals")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
    });

  program
    .command("dashboard")
    .description("Compatibility alias for `talon ops`")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      await startDashboardTui(commandOptions.cwd, resolveSandboxCliOptions(commandOptions));
    });

  const pluginCommand = program.command("plugin").description("Manage local plugin bundles");

  pluginCommand.command("list").action(() => {
    const plugins = listLocalPlugins(process.cwd());
    if (plugins.length === 0) {
      console.log("No local plugins installed.");
      return;
    }
    for (const plugin of plugins) {
      console.log(`${plugin.name}: ${plugin.path}`);
    }
  });

  pluginCommand
    .command("add")
    .argument("<path>", "Local plugin directory")
    .option("--name <name>", "Installed plugin directory name")
    .action((pluginPath: string, commandOptions: { name?: string }) => {
      const result = addLocalPlugin(process.cwd(), pluginPath, commandOptions.name);
      console.log(`Installed plugin ${result.name} at ${result.path}`);
    });

  pluginCommand.command("remove").argument("<name>", "Installed plugin name").action((name: string) => {
    const removed = removeLocalPlugin(process.cwd(), name);
    console.log(`Removed plugin ${removed.name}`);
  });

  const mcpCommand = program.command("mcp").description("Inspect configured MCP client servers");

  mcpCommand
    .command("list")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const servers = await handle.infrastructure.mcpClientManager.listServers();
        if (servers.length === 0) {
          console.log("No MCP servers discovered. Configure .auto-talon/mcp.config.json first.");
          return;
        }
        for (const server of servers) {
          console.log(`${server.id}: ${server.toolCount} tools`);
          if (server.discoveryError !== null) {
            console.log(`  ! discovery error: ${server.discoveryError}`);
          }
          for (const toolName of server.tools) {
            console.log(`  - ${toolName}`);
          }
        }
      } finally {
        handle.close();
      }
    });

  mcpCommand
    .command("ping")
    .argument("<server_id>", "Configured MCP server id")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (serverId: string, commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        await handle.infrastructure.mcpClientManager.ping(serverId);
        console.log(`MCP server ${serverId} is reachable.`);
      } finally {
        handle.close();
      }
    });

  mcpCommand
    .command("serve")
    .option("--transport <transport>", "MCP transport (stdio)", "stdio")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action(async (commandOptions: SandboxCommandOptions & { transport: string }) => {
      if (commandOptions.transport !== "stdio") {
        throw new Error(`Unsupported MCP transport: ${commandOptions.transport}`);
      }
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const config = resolveMcpServerConfig(handle.config.workspaceRoot);
        const server = new McpServer(
          config,
          new McpToolBridge(
            handle.infrastructure.toolOrchestrator,
            handle.config.workspaceRoot,
            config.externalIdentity
          ),
          new McpSkillBridge(handle.infrastructure.skillRegistry)
        );
        const host = new McpStdioHost(server);
        await host.start();
      } finally {
        handle.close();
      }
    });

  const gatewayCommand = program
    .command("gateway")
    .description("Run minimal external gateway adapters");

  gatewayCommand
    .command("serve-webhook")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind", parsePortOption("--port"), 7070)
    .action(async (commandOptions: SandboxCommandOptions & { host: string; port: number }) => {
      const gatewayApp = createGatewayApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      const handle = gatewayApp.runtime;
      const gatewayRuntime = gatewayApp.gateway;
      const gatewayHandle = await startLocalWebhookGateway(handle, {
        host: commandOptions.host,
        port: commandOptions.port
      }, gatewayRuntime);

      console.log(
        `Local webhook adapter ${gatewayHandle.adapter.descriptor.adapterId} listening on http://${commandOptions.host}:${commandOptions.port}`
      );
      console.log("POST /tasks to submit work, GET /tasks/:taskId to inspect, GET /tasks/:taskId/events for SSE.");

      const shutdown = async (): Promise<void> => {
        await gatewayHandle.manager.stopAll();
        gatewayApp.close();
        process.exit(0);
      };

      process.once("SIGINT", () => {
        void shutdown();
      });
      process.once("SIGTERM", () => {
        void shutdown();
      });
    });

  gatewayCommand
    .command("serve-feishu")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--local-webhook-port <port>", "Also start local webhook on this port", parsePortOption("--local-webhook-port"))
    .action(async (commandOptions: SandboxCommandOptions & { localWebhookPort?: number }) => {
      const gatewayApp = createGatewayApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      const handle = gatewayApp.runtime;
      const gatewayRuntime = gatewayApp.gateway;
      let extraManagers: GatewayManager[] = [];
      try {
        const feishu = await startFeishuGateway(handle, gatewayRuntime);
        extraManagers = [feishu.manager];
        if (commandOptions.localWebhookPort !== undefined) {
          const local = await startLocalWebhookGateway(handle, {
            host: "127.0.0.1",
            port: commandOptions.localWebhookPort
          }, gatewayRuntime);
          extraManagers.push(local.manager);
        }

        console.log(`Feishu adapter ${feishu.adapter.descriptor.adapterId} is running.`);
      } catch (error) {
        for (const manager of extraManagers) {
          await manager.stopAll();
        }
        gatewayApp.close();
        throw error;
      }
      const shutdown = async (): Promise<void> => {
        for (const manager of extraManagers) {
          await manager.stopAll();
        }
        gatewayApp.close();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });

  gatewayCommand
    .command("list-adapters")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action((commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const listedAdapters: InboundMessageAdapter[] = [
          new LocalWebhookAdapter({ port: 0, adapterId: "local-webhook" })
        ];
        try {
          if (hasFeishuGatewayConfig(handle.config.workspaceRoot)) {
            listedAdapters.push(createFeishuGatewayPlugin().createAdapter(handle));
          }
        } catch {
          // Optional adapter: only listed when config is present.
        }
        const manager = new GatewayManager(createGatewayRuntime(handle), listedAdapters);
        for (const adapter of manager.listAdapters()) {
          console.log(
            `${adapter.descriptor.adapterId} (${adapter.descriptor.kind}) ${JSON.stringify(adapter.descriptor.capabilities)}`
          );
        }
      } finally {
        handle.close();
      }
    });

  await program.parseAsync(argv);
}

interface SandboxCommandOptions {
  cwd: string;
  sandboxMode?: string;
  sandboxProfile?: string;
  writeRoot?: string[];
}

function createCliOutputListener(jsonEvents: boolean): (event: RuntimeOutputEvent) => void {
  return (event) => {
    if (jsonEvents) {
      console.error(JSON.stringify({ kind: "output", output: event, taskId: event.taskId }));
      return;
    }
    const line = formatCliOutputEvent(event);
    if (line !== null) {
      console.error(line);
    }
  };
}

function formatCliOutputEvent(event: RuntimeOutputEvent): string | null {
  switch (event.eventType) {
    case "task_input":
      return `[task ${event.taskId.slice(0, 8)}] accepted`;
    case "assistant_turn_started":
      return `[turn ${event.payload.iteration}] assistant responding`;
    case "provider_status":
      return `[provider ${event.payload.kind}] ${event.payload.providerName}: ${event.payload.reason}`;
    case "tool_status":
      return `[tool ${event.payload.status}] ${event.payload.toolName}: ${event.payload.summary}`;
    case "approval":
      return `[approval ${event.payload.status}] ${event.payload.toolName}`;
    case "clarification":
      return `[clarification ${event.payload.status}] ${event.payload.question ?? event.payload.promptId}`;
    case "error":
      return `[task ${event.payload.status}] ${event.payload.message}`;
    default:
      return null;
  }
}

interface RunCommandOptions extends SandboxCommandOptions {
  jsonEvents?: boolean;
  maxIterations?: number;
  mode: string;
  profile: string;
  session?: string;
  timeoutMs?: number;
}

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

interface ExperienceFilterOptions {
  limit?: number;
  minValue?: number;
  reviewer?: string;
  scope?: string;
  scopeKey?: string;
  source?: string;
  status?: string;
  taskId?: string;
  type?: string;
}

interface InboxListOptions {
  category?:
    | "task_completed"
    | "task_failed"
    | "task_blocked"
    | "decision_requested"
    | "approval_requested"
    | "memory_suggestion"
    | "skill_promotion";
  limit?: number;
  status?: "pending" | "seen" | "done" | "dismissed";
  user?: string;
}

interface SmokeCommandOptions {
  autoApprove: boolean;
  fixture?: string;
  provider: SupportedProviderName | "scripted-smoke";
  tasks?: string;
}

interface ProviderSetupCommandOptions {
  apiKey?: string;
  baseUrl?: string;
  maxRetries?: number;
  model?: string;
  streamIdleTimeoutMs?: number;
  timeoutMs?: number;
  workspace?: boolean;
}

interface ProviderUseCommandOptions {
  workspace?: boolean;
}

function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parsePositiveIntegerOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${optionName} must be a positive integer.`);
    }
    return parsed;
  };
}

function parseNonNegativeIntegerOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new InvalidArgumentError(`${optionName} must be a non-negative integer.`);
    }
    return parsed;
  };
}

function parsePortOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = parsePositiveIntegerOption(optionName)(value);
    if (parsed > 65535) {
      throw new InvalidArgumentError(`${optionName} must be between 1 and 65535.`);
    }
    return parsed;
  };
}

function resolveProviderConfigTarget(workspace: boolean): { cwd?: string; scope: ProviderConfigScope } {
  if (!workspace) {
    return {
      scope: "user"
    };
  }

  return {
    cwd: resolveAppConfig(process.cwd()).workspaceRoot,
    scope: "workspace"
  };
}

function formatProviderConfigWrite(action: string, result: ProviderConfigWriteResult): string {
  return [
    `${action} ${result.scope} provider: ${result.providerName}`,
    `Model: ${result.model ?? "-"}`,
    `Config Path: ${result.configPath}`,
    "Check: talon provider status",
    "Test: talon provider test"
  ].join("\n");
}

function parseNonNegativeNumberOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new InvalidArgumentError(`${optionName} must be a non-negative number.`);
    }
    return parsed;
  };
}

function parseRatioOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new InvalidArgumentError(`${optionName} must be a number between 0 and 1.`);
    }
    return parsed;
  };
}

function parseNullableOption(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "null" || normalized === "-" ? null : value;
}

async function runSmokeCommand(commandOptions: SmokeCommandOptions): Promise<void> {
  const report = await runSmokeSuite({
    autoApprove: commandOptions.autoApprove,
    ...(commandOptions.fixture !== undefined
      ? { fixturePath: commandOptions.fixture }
      : {}),
    providerName: commandOptions.provider,
    taskIds:
      commandOptions.tasks?.split(",").map((value) => value.trim()).filter(Boolean) ?? []
  });
  console.log(formatSmokeSuiteReport(report));
  if (report.failedCount > 0) {
    process.exitCode = 1;
  }
}

function printWorkspaceMap(cwd: string): void {
  const repoMap = buildRepoMap(cwd);
  console.log(repoMap.summary);
  console.log(`Workspace: ${repoMap.workspaceRoot}`);
  console.log(`Languages: ${repoMap.languages.join(", ") || "-"}`);
  console.log(`Package Manager: ${repoMap.packageManager ?? "-"}`);
  console.log(`Important Files: ${repoMap.importantFiles.join(", ") || "-"}`);
  console.log(
    `Scripts: ${
      Object.keys(repoMap.scripts).length === 0
        ? "-"
        : Object.entries(repoMap.scripts).map(([name, command]) => `${name}=${command}`).join("; ")
    }`
  );
}

function formatWorkspaceChanges(cwd: string): string {
  const status = runGitReadOnly(cwd, ["status", "--short"]);
  const diff = runGitReadOnly(cwd, ["diff", "--stat"]);
  const stagedDiff = runGitReadOnly(cwd, ["diff", "--cached", "--stat"]);
  if (status.error !== null) {
    return `Workspace: ${cwd}\nGit: unavailable\nError: ${status.error}`;
  }

  return [
    `Workspace: ${cwd}`,
    "Git status:",
    status.output.trim().length === 0 ? "  clean" : indent(status.output.trimEnd()),
    "Unstaged diff:",
    diff.output.trim().length === 0 ? "  none" : indent(diff.output.trimEnd()),
    "Staged diff:",
    stagedDiff.output.trim().length === 0 ? "  none" : indent(stagedDiff.output.trimEnd())
  ].join("\n");
}


function indent(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => `  ${line}`)
    .join("\n");
}

function listInboxItems(commandOptions: InboxListOptions): void {
  const handle = createApplication(process.cwd());
  try {
    console.log(
      formatInboxList(
        handle.service.listInbox({
          ...(commandOptions.user !== undefined ? { userId: commandOptions.user } : {}),
          ...(commandOptions.status !== undefined ? { status: commandOptions.status } : {}),
          ...(commandOptions.category !== undefined ? { category: commandOptions.category } : {}),
          ...(commandOptions.limit !== undefined
            ? { limit: commandOptions.limit }
            : {})
        })
      )
    );
  } finally {
    handle.close();
  }
}

function resolveSandboxCliOptions(options: SandboxCommandOptions): ResolveAppConfigOptions {
  return {
    ...(options.sandboxMode === "local" || options.sandboxMode === "docker"
      ? { sandboxMode: options.sandboxMode }
      : {}),
    ...(options.sandboxProfile !== undefined ? { sandboxProfile: options.sandboxProfile } : {}),
    ...(options.writeRoot !== undefined ? { writeRoots: options.writeRoot } : {})
  };
}

function toExperienceQuery(options: ExperienceFilterOptions): ExperienceQuery {
  const query: ExperienceQuery = {};
  if (options.type !== undefined) {
    query.type = options.type as ExperienceType;
  }
  if (options.source !== undefined) {
    query.sourceType = options.source as ExperienceSourceType;
  }
  if (options.status !== undefined) {
    query.status = options.status as ExperienceStatus;
  }
  if (options.minValue !== undefined) {
    query.minValueScore = options.minValue;
  }
  if (options.taskId !== undefined) {
    query.taskId = options.taskId;
  }
  if (options.reviewer !== undefined) {
    query.reviewerId = options.reviewer;
  }
  if (options.scope !== undefined) {
    query.scope = options.scope;
  }
  if (options.scopeKey !== undefined) {
    query.scopeKey = options.scopeKey;
  }
  if (options.limit !== undefined) {
    query.limit = options.limit;
  }
  return query;
}

function parseAttachmentKinds(value: string | undefined): SkillAttachmentKind[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value.split(",").map((entry) => {
    const kind = entry.trim();
    if (
      kind !== "references" &&
      kind !== "templates" &&
      kind !== "scripts" &&
      kind !== "assets"
    ) {
      throw new Error(`Unsupported skill attachment kind: ${kind}`);
    }
    return kind;
  });
}

function listLocalPlugins(cwd: string): Array<{ name: string; path: string }> {
  const root = localPluginsRoot(cwd);
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(root, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function addLocalPlugin(cwd: string, pluginPath: string, name: string | undefined): { name: string; path: string } {
  const source = resolve(pluginPath);
  if (!existsSync(join(source, ".codex-plugin", "plugin.json"))) {
    throw new Error(`Plugin ${source} must contain .codex-plugin/plugin.json.`);
  }
  const pluginName = name ?? basename(source);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(pluginName)) {
    throw new Error(`Invalid plugin name: ${pluginName}`);
  }
  const root = localPluginsRoot(cwd);
  mkdirSync(root, { recursive: true });
  const target = join(root, pluginName);
  if (existsSync(target)) {
    throw new Error(`Plugin already installed: ${pluginName}`);
  }
  cpSync(source, target, { recursive: true });
  return {
    name: pluginName,
    path: target
  };
}

function removeLocalPlugin(cwd: string, name: string): { name: string } {
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(name)) {
    throw new Error(`Invalid plugin name: ${name}`);
  }
  const target = join(localPluginsRoot(cwd), name);
  if (!existsSync(target)) {
    throw new Error(`Plugin not installed: ${name}`);
  }
  rmSync(target, { recursive: true, force: true });
  return { name };
}

function localPluginsRoot(cwd: string): string {
  return join(resolve(cwd), ".auto-talon", "plugins");
}

function resolveScopeKey(
  scope: "profile" | "project" | "working" | "experience_ref" | "skill_ref",
  options: {
    cwd: string;
    profile: string;
    scopeKey: string | undefined;
    taskId: string | undefined;
    user: string | undefined;
  }
): string {
  if (options.scopeKey !== undefined) {
    return options.scopeKey;
  }

  if (scope === "working") {
    if (options.taskId === undefined) {
      throw new Error("Working scope requires --task-id or --scope-key.");
    }

    return options.taskId;
  }

  if (scope === "project" || scope === "experience_ref" || scope === "skill_ref") {
    return options.cwd;
  }

  const userId = options.user ?? process.env.USERNAME ?? process.env.USER ?? "local-user";
  return `${userId}:${options.profile}`;
}

function normalizeMemoryScope(
  scope: "profile" | "project" | "working" | "experience_ref" | "skill_ref" | "session" | "agent"
): "profile" | "project" | "working" | "experience_ref" | "skill_ref" {
  if (scope === "session") {
    return "working";
  }
  if (scope === "agent") {
    return "profile";
  }
  return scope;
}

function parseApprovalAllowScope(value: string | undefined): ApprovalAllowScope {
  if (value === undefined || value === "once") {
    return "once";
  }
  if (value === "session" || value === "always") {
    return value;
  }
  throw new InvalidArgumentError("Scope must be once, session, or always.");
}
