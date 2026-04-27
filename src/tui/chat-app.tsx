import { randomUUID } from "node:crypto";
import React from "react";
import { Box, Text, useApp } from "ink";

import type { AgentApplicationService, AppConfig } from "../runtime/index.js";
import { Banner } from "./components/banner.js";
import { InputBox } from "./components/input-box.js";
import { MessageStream, StaticMessageStream } from "./components/message-stream.js";
import { buildTokenMetrics, StatusBar } from "./components/status-bar.js";
import { useChatController } from "./hooks/use-chat-controller.js";
import { useTextInput } from "./hooks/use-text-input.js";
import { listSessionIds, saveSession } from "./session-store.js";
import { completeSlashCommand, SLASH_COMMANDS } from "./slash-commands.js";
import { theme } from "./theme.js";
import { displayChatMessages, type ChatMessage } from "./view-models/chat-messages.js";
import {
  buildTodaySummary,
  formatThreadDetailForTui,
  formatTodaySummary,
  resolveRuntimeUserId
} from "./view-models/today-summary.js";

export interface ChatTuiAppProps {
  config: AppConfig;
  cwd: string;
  initialMessages?: ChatMessage[];
  initialSessionId: string;
  initialThreadId?: string;
  reviewerId: string;
  service: AgentApplicationService;
}

export function ChatTuiApp({
  config,
  cwd,
  initialMessages,
  initialSessionId,
  initialThreadId,
  reviewerId,
  service
}: ChatTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const [sessionTitle, setSessionTitle] = React.useState("assistant");
  const [sessionId, setSessionId] = React.useState(initialSessionId);
  const historyRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef<number | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const controller = useChatController({
    config,
    cwd,
    ...(initialMessages !== undefined ? { initialMessages } : {}),
    ...(initialThreadId !== undefined ? { initialThreadId } : {}),
    reviewerId,
    service
  });

  const displayMessages = React.useMemo(
    () => displayChatMessages(controller.messages),
    [controller.messages]
  );
  const staticMessages = React.useMemo(
    () => displayMessages.filter((message) => !isLiveTranscriptMessage(message)),
    [displayMessages]
  );
  const liveMessages = React.useMemo(
    () => displayMessages.filter(isLiveTranscriptMessage),
    [displayMessages]
  );
  const todaySummaryText = React.useMemo(
    () => formatTodaySummary(buildTodaySummary(service, { activeThreadId: controller.activeThreadId })),
    [controller.activeThreadId, service]
  );
  const showTodaySummary = React.useMemo(
    () => isEmptyConversation(controller.messages),
    [controller.messages]
  );

  React.useEffect(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    if (controller.busy) {
      return;
    }
    saveTimerRef.current = setTimeout(() => {
      void saveSession(config.workspaceRoot, {
        id: sessionId,
        messages: controller.messages,
        ...(controller.activeThreadId !== null ? { threadId: controller.activeThreadId } : {}),
        updatedAt: new Date().toISOString()
      });
    }, 600);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [config.workspaceRoot, controller.busy, controller.messages, sessionId]);

  const navigateHistoryPrevious = React.useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0) {
      return null;
    }
    if (historyIndexRef.current === null) {
      historyIndexRef.current = history.length - 1;
      return history[historyIndexRef.current] ?? null;
    }
    historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
    return history[historyIndexRef.current] ?? null;
  }, []);

  const navigateHistoryNext = React.useCallback((): string | null => {
    const history = historyRef.current;
    if (history.length === 0 || historyIndexRef.current === null) {
      return "";
    }
    historyIndexRef.current = Math.min(history.length, historyIndexRef.current + 1);
    if (historyIndexRef.current === history.length) {
      historyIndexRef.current = null;
      return "";
    }
    return history[historyIndexRef.current] ?? "";
  }, []);

  const handleSlashCommand = React.useCallback(
    (text: string): boolean => {
      if (!text.startsWith("/")) {
        return false;
      }

      if (text === "/help") {
        controller.addSystemMessage(
          [
            "Commands: /today /inbox /thread [summary|list|new|switch] /next [list|done|block] /commitments [list|done|block] /schedule /help /ops /status /clear /new /stop /history /context /cost /diff /sandbox /sessions /rollback <id|last> /title <name>",
            "Compatibility: /dashboard remains available and maps to /ops.",
            "Tip: use `talon ops` or `talon tui --mode ops` for the observability view.",
            "Shortcuts: Enter send | Alt+Enter / Ctrl+J newline | Ctrl+Shift+V paste | Tab slash-complete | Ctrl+P/N history",
            "Session files: .auto-talon/sessions/<id>.json | resume: talon tui --resume <id>",
            "Token pricing estimate: AGENT_TOKEN_PRICE_IN_PER_M / AGENT_TOKEN_PRICE_OUT_PER_M (optional)",
            "Transcript scroll uses the terminal buffer; use your terminal scrollbar or mouse wheel."
          ].join("\n")
        );
        return true;
      }

      if (text === "/today") {
        controller.addSystemMessage(todaySummaryText);
        return true;
      }

      if (text === "/inbox") {
        const userId = resolveRuntimeUserId();
        const items = service
          .listInbox({ status: "pending", userId })
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, 20);
        controller.addSystemMessage(
          items.length === 0
            ? `Inbox pending (user=${userId}): none`
            : `Inbox pending (user=${userId}, showing ${items.length}):\n${items
                .map((item) => `- ${item.inboxId.slice(0, 8)} | ${item.title} [${item.status}]`)
                .join("\n")}`
        );
        return true;
      }

      if (text.startsWith("/thread")) {
        return handleThreadCommand(text, controller, service);
      }

      if (text.startsWith("/next")) {
        return handleNextActionCommand(text, controller, service);
      }

      if (text.startsWith("/commitments")) {
        return handleCommitmentCommand(text, controller, service);
      }

      if (text === "/schedule") {
        const userId = resolveRuntimeUserId();
        const schedules = service
          .listSchedules({ ownerUserId: userId, status: "active" })
          .sort((left, right) => (left.nextFireAt ?? "9999").localeCompare(right.nextFireAt ?? "9999"))
          .slice(0, 20);
        controller.addSystemMessage(
          schedules.length === 0
            ? `Schedules (user=${userId}): none`
            : `Schedules (user=${userId}, showing ${schedules.length}):\n${schedules
                .map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name} | next=${item.nextFireAt ?? "none"}`)
                .join("\n")}`
        );
        return true;
      }

      if (text === "/ops") {
        controller.addSystemMessage("Open ops with: talon ops (or talon tui --mode ops).");
        return true;
      }

      if (text === "/clear") {
        controller.clearConversation();
        return true;
      }

      if (text === "/new") {
        controller.clearConversation();
        setSessionTitle("assistant");
        const nextId = randomUUID();
        setSessionId(nextId);
        controller.addSystemMessage(`Started a new assistant session. id=${nextId}`);
        return true;
      }

      if (text === "/stop") {
        const requested = controller.requestInterrupt();
        controller.addSystemMessage(requested ? "Stop requested for current task." : "No running task to stop.");
        return true;
      }

      if (text === "/history") {
        const items = historyRef.current.slice(-20);
        if (items.length === 0) {
          controller.addSystemMessage("No prompt history yet.");
          return true;
        }
        const lines = items
          .map((line, index) => `${String(index + 1).padStart(2, " ")}. ${line.replace(/\n/gu, " ")}`)
          .join("\n");
        controller.addSystemMessage(`Recent prompts (last ${items.length}):\n${lines}`);
        return true;
      }

      if (text === "/cost") {
        const u = controller.tokenHud;
        controller.addSystemMessage(
          `Session token estimate (provider telemetry): in=${u.inputTokens} out=${u.outputTokens} | ~$${u.estimatedCostUsd.toFixed(4)}`
        );
        return true;
      }

      if (text === "/context") {
        const b = config.tokenBudget;
        controller.addSystemMessage(
          [
            `Context vs configured budget: ${controller.tokenHud.contextPercent}% of ~${b.inputLimit + b.outputLimit} tokens (inputLimit=${b.inputLimit} outputLimit=${b.outputLimit}).`,
            `Used (telemetry): input=${controller.tokenHud.inputTokens} output=${controller.tokenHud.outputTokens}`
          ].join("\n")
        );
        return true;
      }

      if (text === "/diff") {
        controller.addSystemMessage(controller.formatDiffSummary());
        return true;
      }

      if (text === "/sessions") {
        void listSessionIds(config.workspaceRoot).then((ids) => {
          controller.addSystemMessage(
            ids.length > 0 ? `Saved session ids (newest files under .auto-talon/sessions):\n${ids.join("\n")}` : "No saved sessions yet."
          );
        });
        return true;
      }

      if (text === "/dashboard") {
        controller.addSystemMessage("`/dashboard` is a compatibility alias. Use /ops, talon ops, or talon tui --mode ops.");
        return true;
      }

      if (text === "/status") {
        const lines = [
          `session: ${sessionTitle}`,
          `session_id: ${sessionId}`,
          `cwd: ${cwd}`,
          `sandbox_mode: ${config.sandbox.mode}`,
          `write_roots: ${config.sandbox.writeRoots.join(", ")}`,
          `model: ${config.provider.model ?? config.provider.name}`,
          `provider: ${config.provider.name}`,
          `reviewer: ${reviewerId}`,
          `thread: ${controller.activeThreadId ?? "(none)"}`,
          `busy: ${controller.busy}`,
          `active_task: ${controller.activeTaskId ?? "(none)"}`,
          `tasks: ${controller.summary.tasks} running: ${controller.summary.runningTasks} approvals: ${controller.summary.pendingApprovals}`,
          `status_line: ${controller.statusLine}`,
          `ui_status: ${controller.uiStatus.primaryLabel}`,
          `elapsed: ${controller.runDurationLabel}`,
          "ui_scroll: terminal",
          `message_rows: ${controller.messages.length}`,
          `tokens_in: ${controller.tokenHud.inputTokens} tokens_out: ${controller.tokenHud.outputTokens}`,
          `context_pct: ${controller.tokenHud.contextPercent} est_cost_usd: ${controller.tokenHud.estimatedCostUsd.toFixed(4)}`
        ];
        controller.addSystemMessage(lines.join("\n"));
        return true;
      }

      if (text === "/sandbox") {
        const sandbox = config.sandbox;
        controller.addSystemMessage(
          [
            `sandbox_mode: ${sandbox.mode}`,
            `sandbox_profile: ${sandbox.profileName ?? "(default)"}`,
            `sandbox_source: ${sandbox.configSource}`,
            `workspace: ${sandbox.workspaceRoot}`,
            `write_roots: ${sandbox.writeRoots.join(", ")}`,
            `read_roots: ${sandbox.readRoots.join(", ")}`
          ].join("\n")
        );
        return true;
      }

      if (text.startsWith("/rollback ")) {
        const artifactId = text.slice("/rollback ".length).trim();
        if (artifactId.length === 0) {
          controller.addSystemMessage("Usage: /rollback last|<artifact_id>");
          return true;
        }

        void service
          .rollbackFileArtifact(artifactId)
          .then((result) => {
            controller.addSystemMessage(
              result.deleted
                ? `Rolled back by deleting ${result.path}`
                : `Rolled back by restoring ${result.path}`
            );
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            controller.addSystemMessage(`Rollback failed: ${message}`);
          });
        return true;
      }

      if (text.startsWith("/title ")) {
        const nextTitle = text.slice("/title ".length).trim();
        if (nextTitle.length === 0) {
          controller.addSystemMessage("Usage: /title <name>");
          return true;
        }
        setSessionTitle(nextTitle);
        controller.addSystemMessage(`Session title set to: ${nextTitle}`);
        return true;
      }

      controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
      return true;
    },
    [
      config.provider.model,
      config.provider.name,
      config.sandbox,
      config.tokenBudget,
      config.workspaceRoot,
      controller,
      cwd,
      reviewerId,
      service,
      sessionId,
      sessionTitle
    ]
  );

  const textInput = useTextInput({
    busy: controller.busy,
    hasPendingApproval: controller.hasPendingApproval,
    onHistoryNext: navigateHistoryNext,
    onHistoryPrevious: navigateHistoryPrevious,
    onImagePasteAttempt: () => {
      controller.addSystemMessage(
        "Image paste (Alt+V): multimodal clipboard is not wired to providers in this build. Add an image path or use a vision-capable flow outside the TUI."
      );
    },
    onInterruptRequest: () => {
      const requested = controller.requestInterrupt();
      controller.addSystemMessage(
        requested
          ? "Interrupt requested. Press Ctrl+C again within 2s to force exit if shutdown is needed."
          : "No running task to interrupt."
      );
    },
    onApprovalAction: (action) => {
      void controller.resolvePendingApproval(action);
    },
    onExit: exit,
    onTabComplete: completeSlashCommand,
    onSubmit: (value) => {
      if (handleSlashCommand(value)) {
        return true;
      }
      const accepted = controller.submitPrompt(value);
      if (!accepted) {
        return false;
      }
      historyRef.current.push(value);
      if (historyRef.current.length > 200) {
        historyRef.current = historyRef.current.slice(-200);
      }
      historyIndexRef.current = null;
      return true;
    },
    onSubmitBlockedBusy: () => {
      controller.addSystemMessage("Agent is still running. Wait for completion or use /stop to interrupt.");
    }
  });

  const slashHints =
    textInput.value.startsWith("/") && textInput.value.length > 0
      ? SLASH_COMMANDS.filter((command) => command.startsWith(textInput.value))
      : [];

  return (
    <Box flexDirection="column">
      <StaticMessageStream messages={staticMessages} />
      <Banner
        details={[config.provider.model ?? config.provider.name, shortenPath(cwd, 20)]}
        productName="AUTOTALON"
        title={sessionTitle === "assistant" ? "Personal Assistant" : sessionTitle}
      />
      <Box flexDirection="column">
        {liveMessages.length > 0 ? (
          <MessageStream messages={liveMessages} />
        ) : showTodaySummary ? (
          <Text color={theme.muted}>{todaySummaryText}</Text>
        ) : staticMessages.length === 0 ? (
          <Text color={theme.muted}>No conversation yet.</Text>
        ) : null}
      </Box>
      <Box>
        <InputBox
          busy={controller.busy}
          hasPendingApproval={controller.hasPendingApproval}
          lines={textInput.lines}
          slashHints={slashHints}
          value={textInput.value}
        />
      </Box>
      <Box>
        <StatusBar
          details={[`elapsed ${controller.runDurationLabel}`]}
          hints={[controller.hasPendingApproval ? "a allow, d deny" : "Enter send"]}
          metrics={buildTokenMetrics(
            controller.tokenHud.inputTokens,
            controller.tokenHud.outputTokens,
            controller.tokenHud.contextPercent,
            controller.tokenHud.estimatedCostUsd
          )}
          primary={{
            label: controller.uiStatus.primaryLabel,
            tone: controller.uiStatus.primaryTone
          }}
        />
      </Box>
    </Box>
  );
}

function shortenPath(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `...${value.slice(-(maxLength - 3))}`;
}

function isLiveTranscriptMessage(message: ChatMessage): boolean {
  return (
    (message.kind === "agent" && message.streaming === true) ||
    (message.kind === "approval" && message.status === "pending")
  );
}

function isEmptyConversation(messages: ChatMessage[]): boolean {
  return !messages.some((message) => message.kind === "user" || message.kind === "agent");
}

function parseSlashInput(text: string): { args: string[]; command: string; rest: string } {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/u).filter((part) => part.length > 0);
  const command = parts[0] ?? "";
  const args = parts.slice(1);
  const rest = command.length >= trimmed.length ? "" : trimmed.slice(command.length).trim();
  return { args, command, rest };
}

function handleThreadCommand(text: string, controller: ReturnType<typeof useChatController>, service: AgentApplicationService): boolean {
  const parsed = parseSlashInput(text);
  const sub = parsed.args[0] ?? "summary";
  if (parsed.command !== "/thread") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }

  if (sub === "new") {
    const title = parsed.rest.slice("new".length).trim() || "Untitled thread";
    const threadId = controller.createAndActivateThread(title);
    controller.resetVisibleChatPreserveActiveThread();
    controller.addSystemMessage(`Switched to new thread ${threadId.slice(0, 8)} | ${title}`);
    controller.addSystemMessage(formatThreadDetailForTui(service, threadId));
    return true;
  }

  if (sub === "switch") {
    const prefix = parsed.args[1] ?? "";
    if (prefix.length === 0) {
      controller.addSystemMessage("Usage: /thread switch <thread-id-prefix>");
      return true;
    }
    const userId = resolveRuntimeUserId();
    const candidates = service
      .listThreads("active")
      .filter((item) => item.ownerUserId === userId && item.threadId.startsWith(prefix));
    if (candidates.length !== 1) {
      controller.addSystemMessage(
        candidates.length === 0
          ? `No thread matched prefix '${prefix}'.`
          : `Ambiguous thread prefix '${prefix}':\n${candidates.map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title}`).join("\n")}`
      );
      return true;
    }
    const match = candidates[0];
    if (match === undefined) {
      return true;
    }
    controller.switchActiveThread(match.threadId);
    controller.resetVisibleChatPreserveActiveThread();
    controller.addSystemMessage(`Switched to thread ${match.threadId.slice(0, 8)} | ${match.title}`);
    controller.addSystemMessage(formatThreadDetailForTui(service, match.threadId));
    return true;
  }

  if (sub === "list") {
    const userId = resolveRuntimeUserId();
    const threads = service
      .listThreads("active")
      .filter((item) => item.ownerUserId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
    controller.addSystemMessage(
      threads.length === 0
        ? `Active threads (user=${userId}): none`
        : `Active threads (user=${userId}, showing ${threads.length}):\n${threads
            .map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }

  if (sub === "summary") {
    const maybePrefix = parsed.args[1] ?? "";
    if (maybePrefix.length > 0) {
      const userId = resolveRuntimeUserId();
      const candidates = service
        .listThreads("active")
        .filter((item) => item.ownerUserId === userId && item.threadId.startsWith(maybePrefix));
      if (candidates.length !== 1) {
        controller.addSystemMessage(
          candidates.length === 0
            ? `No thread matched prefix '${maybePrefix}'.`
            : `Ambiguous thread prefix '${maybePrefix}':\n${candidates.map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title}`).join("\n")}`
        );
        return true;
      }
      controller.addSystemMessage(formatThreadDetailForTui(service, candidates[0]!.threadId));
      return true;
    }
    if (controller.activeThreadId !== null) {
      controller.addSystemMessage(formatThreadDetailForTui(service, controller.activeThreadId));
    } else {
      return handleThreadCommand("/thread list", controller, service);
    }
    return true;
  }

  controller.addSystemMessage("Usage: /thread [new [title]|list|switch <thread-id-prefix>|summary [thread-id-prefix]]");
  return true;
}

function handleNextActionCommand(text: string, controller: ReturnType<typeof useChatController>, service: AgentApplicationService): boolean {
  const { args, command } = parseSlashInput(text);
  if (command !== "/next") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const requestedThreadPrefix = args[1] ?? "";
    const threadId = resolveThreadIdForList(controller.activeThreadId, requestedThreadPrefix, service);
    if (threadId.kind === "error") {
      controller.addSystemMessage(threadId.message);
      return true;
    }
    const resolvedThreadId = threadId.threadId;
    const query =
      resolvedThreadId === null
        ? { statuses: ["active", "pending", "blocked"] as Array<"active" | "pending" | "blocked"> }
        : { threadId: resolvedThreadId };
    const items = service.listNextActions(query).slice(0, 20);
    const scope = resolvedThreadId === null ? `user=${resolveRuntimeUserId()}` : `thread=${resolvedThreadId.slice(0, 8)}`;
    controller.addSystemMessage(
      items.length === 0
        ? `Next actions (${scope}): none`
        : `Next actions (${scope}, showing ${items.length}):\n${items
            .map((item) => `- ${item.nextActionId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }
  const prefix = args[1] ?? "";
  if (prefix.length === 0) {
    controller.addSystemMessage(sub === "block" ? "Usage: /next block <next-action-id-prefix> <reason...>" : "Usage: /next done <next-action-id-prefix>");
    return true;
  }
  const matches = resolveNextActionByPrefix(prefix, controller.activeThreadId, service);
  if (matches.kind !== "one") {
    controller.addSystemMessage(matches.message);
    return true;
  }
  if (sub === "done") {
    const updated = service.markNextActionDone(matches.item.nextActionId);
    controller.addSystemMessage(`Next action done: ${updated.nextActionId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  if (sub === "block") {
    const reason = args.slice(2).join(" ").trim();
    if (reason.length === 0) {
      controller.addSystemMessage("Usage: /next block <next-action-id-prefix> <reason...>");
      return true;
    }
    const updated = service.blockNextAction(matches.item.nextActionId, reason);
    controller.addSystemMessage(`Next action blocked: ${updated.nextActionId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  controller.addSystemMessage("Usage: /next [list [thread-id-prefix]|done <next-action-id-prefix>|block <next-action-id-prefix> <reason...>]");
  return true;
}

function handleCommitmentCommand(text: string, controller: ReturnType<typeof useChatController>, service: AgentApplicationService): boolean {
  const { args, command } = parseSlashInput(text);
  if (command !== "/commitments") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const requestedThreadPrefix = args[1] ?? "";
    const threadId = resolveThreadIdForList(controller.activeThreadId, requestedThreadPrefix, service);
    if (threadId.kind === "error") {
      controller.addSystemMessage(threadId.message);
      return true;
    }
    const resolvedThreadId = threadId.threadId;
    const query =
      resolvedThreadId === null
        ? {
            ownerUserId: resolveRuntimeUserId(),
            statuses: ["open", "in_progress", "blocked", "waiting_decision"] as Array<
              "open" | "in_progress" | "blocked" | "waiting_decision"
            >
          }
        : { threadId: resolvedThreadId };
    const items = service.listCommitments(query).slice(0, 20);
    const scope = resolvedThreadId === null ? `user=${resolveRuntimeUserId()}` : `thread=${resolvedThreadId.slice(0, 8)}`;
    controller.addSystemMessage(
      items.length === 0
        ? `Commitments (${scope}): none`
        : `Commitments (${scope}, showing ${items.length}):\n${items
            .map((item) => `- ${item.commitmentId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }
  const prefix = args[1] ?? "";
  if (prefix.length === 0) {
    controller.addSystemMessage(
      sub === "block"
        ? "Usage: /commitments block <commitment-id-prefix> <reason...>"
        : "Usage: /commitments done <commitment-id-prefix>"
    );
    return true;
  }
  const matches = resolveCommitmentByPrefix(prefix, controller.activeThreadId, service);
  if (matches.kind !== "one") {
    controller.addSystemMessage(matches.message);
    return true;
  }
  if (sub === "done") {
    const updated = service.completeCommitment(matches.item.commitmentId);
    controller.addSystemMessage(`Commitment completed: ${updated.commitmentId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  if (sub === "block") {
    const reason = args.slice(2).join(" ").trim();
    if (reason.length === 0) {
      controller.addSystemMessage("Usage: /commitments block <commitment-id-prefix> <reason...>");
      return true;
    }
    const updated = service.blockCommitment(matches.item.commitmentId, reason);
    controller.addSystemMessage(`Commitment blocked: ${updated.commitmentId.slice(0, 8)} | ${updated.title}`);
    return true;
  }
  controller.addSystemMessage("Usage: /commitments [list [thread-id-prefix]|done <commitment-id-prefix>|block <commitment-id-prefix> <reason...>]");
  return true;
}

function resolveThreadIdForList(
  activeThreadId: string | null,
  prefix: string,
  service: AgentApplicationService
): { kind: "ok"; threadId: string | null } | { kind: "error"; message: string } {
  if (prefix.length === 0) {
    return { kind: "ok", threadId: activeThreadId };
  }
  const userId = resolveRuntimeUserId();
  const matches = service
    .listThreads("active")
    .filter((item) => item.ownerUserId === userId && item.threadId.startsWith(prefix));
  if (matches.length === 1) {
    return { kind: "ok", threadId: matches[0]!.threadId };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No thread matched prefix '${prefix}'.`
        : `Ambiguous thread prefix '${prefix}':\n${matches.map((item) => `- ${item.threadId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}

function resolveNextActionByPrefix(
  prefix: string,
  activeThreadId: string | null,
  service: AgentApplicationService
):
  | { item: ReturnType<AgentApplicationService["listNextActions"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const items = activeThreadId === null ? service.listNextActions() : service.listNextActions({ threadId: activeThreadId });
  const matches = items.filter((item) => item.nextActionId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  if (matches.length === 0 && activeThreadId !== null) {
    const globalMatches = service.listNextActions().filter((item) => item.nextActionId.startsWith(prefix));
    if (globalMatches.length === 1) {
      return { item: globalMatches[0]!, kind: "one" };
    }
    return {
      kind: "error",
      message:
        globalMatches.length === 0
          ? `No next action matched prefix '${prefix}'.`
          : `Ambiguous next action prefix '${prefix}':\n${globalMatches
              .map((item) => `- ${item.nextActionId.slice(0, 8)} | ${item.title}`)
              .join("\n")}`
    };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No next action matched prefix '${prefix}'.`
        : `Ambiguous next action prefix '${prefix}':\n${matches.map((item) => `- ${item.nextActionId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}

function resolveCommitmentByPrefix(
  prefix: string,
  activeThreadId: string | null,
  service: AgentApplicationService
):
  | { item: ReturnType<AgentApplicationService["listCommitments"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const items = activeThreadId === null ? service.listCommitments() : service.listCommitments({ threadId: activeThreadId });
  const matches = items.filter((item) => item.commitmentId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  if (matches.length === 0 && activeThreadId !== null) {
    const globalMatches = service.listCommitments().filter((item) => item.commitmentId.startsWith(prefix));
    if (globalMatches.length === 1) {
      return { item: globalMatches[0]!, kind: "one" };
    }
    return {
      kind: "error",
      message:
        globalMatches.length === 0
          ? `No commitment matched prefix '${prefix}'.`
          : `Ambiguous commitment prefix '${prefix}':\n${globalMatches
              .map((item) => `- ${item.commitmentId.slice(0, 8)} | ${item.title}`)
              .join("\n")}`
    };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No commitment matched prefix '${prefix}'.`
        : `Ambiguous commitment prefix '${prefix}':\n${matches.map((item) => `- ${item.commitmentId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}
