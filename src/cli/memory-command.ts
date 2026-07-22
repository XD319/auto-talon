import type { Command } from "commander";

import {
  createApplication,
  resolveDefaultReviewerId,
  resolveDefaultUserId
} from "../runtime/index.js";
import {
  formatExperienceList,
  formatInboxDetail,
  formatMemoryGuide,
  formatMemoryList,
  formatMemoryRecallExplanation,
  formatMemoryScope,
  formatMemorySuggestionQueue,
  formatSessionSummarySearchHits,
  formatSkillList,
  formatSnapshot
} from "./formatters.js";
import { formatCuratedMemorySearchHits, formatSessionMessageSearchHits } from "./memory-search-formatters.js";
import { parsePositiveIntegerOption } from "./cli-helpers.js";
import { MemoryMaintenanceService } from "../memory/memory-maintenance.js";

type InboxListStatus = "pending" | "seen" | "done" | "dismissed";

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

  const userId = options.user ?? resolveDefaultUserId();
  return `${userId}:${options.profile}`;
}

export function registerMemoryCommands(program: Command): void {
  const memoryCommand = program.command("memory").description("Inspect governed memories");

  memoryCommand.command("status").description("Show whether long-term memory is enabled").action(() => {
    const handle = createApplication(process.cwd());
    try {
      const status = handle.service.getLongTermMemoryStatus(process.cwd());
      console.log(`Long-term memory: ${status.enabled ? "on" : "off"}\nConfig: ${status.configPath}`);
    } finally {
      handle.close();
    }
  });

  for (const enabled of [true, false] as const) {
    memoryCommand.command(enabled ? "on" : "off")
      .description(`${enabled ? "Enable" : "Disable"} long-term memory for this workspace`)
      .action(() => {
        const handle = createApplication(process.cwd());
        try {
          const status = handle.service.setLongTermMemoryEnabled(process.cwd(), enabled);
          console.log(`Long-term memory is now ${status.enabled ? "on" : "off"}.`);
        } finally {
          handle.close();
        }
      });
  }
  const maintenanceCommand = memoryCommand.command("maintenance").description("Archive and rebuild legacy memory data");
  maintenanceCommand.command("rebuild")
    .option("--dry-run", "Preview changes without modifying data")
    .option("--apply", "Back up and apply changes")
    .action((options: { dryRun?: boolean; apply?: boolean }) => {
      if (options.dryRun === options.apply) throw new Error("Choose exactly one of --dry-run or --apply.");
      const handle = createApplication(process.cwd());
      try {
        const service = new MemoryMaintenanceService(handle.infrastructure.storage.database, handle.config.databasePath);
        console.log(JSON.stringify(service.rebuild(options.apply === true ? "apply" : "dry-run"), null, 2));
      } finally { handle.close(); }
    });

  memoryCommand.command("doctor").description("Report long-term memory health and coverage").action(() => {
    const handle = createApplication(process.cwd());
    try {
      const service = new MemoryMaintenanceService(handle.infrastructure.storage.database, handle.config.databasePath);
      console.log(JSON.stringify(service.doctor(), null, 2));
    } finally { handle.close(); }
  });
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
            commandOptions.reviewer ?? resolveDefaultReviewerId();
          const userId = commandOptions.user ?? resolveDefaultUserId();
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
          commandOptions.reviewer ?? resolveDefaultReviewerId();
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
    .argument("<query>", "Search query")
    .option("--session <sessionId>", "Search session summaries within a session")
    .option("--global", "Search session summaries across all sessions")
    .option("--exclude-session <sessionId>", "Exclude one session from global summary search")
    .option("--messages", "Search session message transcripts via FTS")
    .option("--curated", "Search approved long-term memories via FTS")
    .option("--limit <number>", "Max hit count", parsePositiveIntegerOption("--limit"), 5)
    .action(
      (
        query: string,
        commandOptions: {
          session?: string;
          global?: boolean;
          excludeSession?: string;
          messages?: boolean;
          curated?: boolean;
          limit: number;
        }
      ) => {
        const handle = createApplication(process.cwd());
        try {
          if (commandOptions.curated === true) {
            const hits = handle.service.searchCuratedMemories({
              limit: commandOptions.limit,
              query
            });
            console.log(formatCuratedMemorySearchHits(hits));
            return;
          }
          if (commandOptions.messages === true) {
            const hits = handle.service.searchSessionMessages({
              limit: commandOptions.limit,
              query,
              ...(commandOptions.session !== undefined
                ? { sessionIdPrefix: commandOptions.session }
                : {})
            });
            console.log(formatSessionMessageSearchHits(hits));
            return;
          }
          if (commandOptions.global !== true && commandOptions.session === undefined) {
            throw new Error("Provide --session <sessionId>, --global, --messages, or --curated.");
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
            commandOptions.reviewer ?? resolveDefaultReviewerId();
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
            commandOptions.reviewer ?? resolveDefaultReviewerId();
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
    .action((commandOptions: { limit?: number; status?: InboxListStatus; user?: string }) => {
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
          commandOptions.reviewer ?? resolveDefaultReviewerId();
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

  memoryCommand
    .command("resolve-conflict")
    .description("Keep one memory and archive its conflicting rival")
    .requiredOption("--keep <memoryId>", "Memory id to keep")
    .requiredOption("--archive <memoryId>", "Conflicting memory id to archive")
    .option("--reviewer <reviewer>", "Reviewer id")
    .option("--note <note>", "Resolution note")
    .action(
      (commandOptions: { keep: string; archive: string; reviewer?: string; note?: string }) => {
        const handle = createApplication(process.cwd());
        try {
          const reviewer = commandOptions.reviewer ?? resolveDefaultReviewerId();
          const result = handle.service.resolveMemoryConflict({
            archiveMemoryId: commandOptions.archive,
            keepMemoryId: commandOptions.keep,
            reviewerId: reviewer,
            ...(commandOptions.note !== undefined ? { note: commandOptions.note } : {})
          });
          console.log("Kept:");
          console.log(formatMemoryList([result.kept]));
          console.log("Archived:");
          console.log(formatMemoryList([result.archived]));
        } finally {
          handle.close();
        }
      }
    );
}
