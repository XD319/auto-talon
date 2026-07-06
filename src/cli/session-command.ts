import type { Command } from "commander";

import { assertSafeHttpBind } from "../core/http-auth.js";
import { createApplication, resolveDefaultReviewerId, resolveDefaultUserId } from "../runtime/index.js";
import { startSessionApiServer } from "../session-api/server.js";
import type { CommitmentRecord } from "../types/index.js";
import {
  formatApprovalList,
  formatCommitmentDetail,
  formatCommitmentList,
  formatInboxDetail,
  formatInboxList,
  formatNextActionList,
  formatSessionDetail,
  formatSessionList,
  formatSessionSummary,
  formatSessionSummaryList
} from "./formatters.js";
import { parseApprovalAllowScope, parsePositiveIntegerOption } from "./cli-helpers.js";

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

export function registerSessionCommands(program: Command): void {
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
        const ownerUserId = resolveDefaultUserId();
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
    .option("--insecure", "Allow binding to non-loopback hosts without HTTP token")
    .action(async (commandOptions: { host?: string; insecure?: boolean; port?: string }) => {
      const cwd = process.cwd();
      const host = commandOptions.host ?? "127.0.0.1";
      assertSafeHttpBind({ cwd, host, insecure: commandOptions.insecure === true });
      const handle = createApplication(cwd, { scheduler: { autoStart: true } });
      const port = Number.parseInt(commandOptions.port ?? "7080", 10);
      try {
        const started = await startSessionApiServer({
          cwd,
          host,
          port: Number.isFinite(port) ? port : 7080,
          service: handle.service
        });
        console.log(`Session API listening at ${started.url}`);
        await new Promise<void>((resolve) => {
          const shutdown = (): void => {
            resolve();
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
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
      const reviewer = resolveDefaultReviewerId();
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
        const ownerUserId = resolveDefaultUserId();
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
        const reviewerId = commandOptions.reviewer ?? resolveDefaultReviewerId();
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
          process.exitCode = 1;
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
          commandOptions.reviewer ?? resolveDefaultReviewerId();
        const result = await handle.service.resolveApproval(approvalId, "deny", reviewerId);
        console.log(`Approval: ${result.approval.approvalId} ${result.approval.status}`);
        console.log(`Task ID: ${result.task.taskId}`);
        console.log(`Status: ${result.task.status}`);
      } finally {
        handle.close();
      }
    });
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
