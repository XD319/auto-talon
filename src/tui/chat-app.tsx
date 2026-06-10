import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import React from "react";
import { Box, useApp } from "ink";

import type { TuiAppConfig, TuiRuntimeService } from "./runtime-api.js";
import { parseNaturalLanguageScheduleWhen } from "../runtime/scheduler/index.js";
import type { ApprovalAllowScope, InboxItem, TuiInteractionMode } from "../types/index.js";
import {
  formatMemoryGuide,
  formatMemoryList,
  formatMemoryRecallExplanation,
  formatMemorySuggestionQueue
} from "../presentation/memory-formatters.js";
import { Banner } from "./components/banner.js";
import { InputBox } from "./components/input-box.js";
import { PromptZone } from "./components/prompt-zone.js";
import { buildContextMetric, StatusBar } from "./components/status-bar.js";
import type { SessionIndexEntry } from "../types/index.js";
import { SessionBrowser } from "./components/session-browser.js";
import { SessionRecap } from "./components/session-recap.js";
import { editInExternalEditor } from "./external-editor.js";
import { useChatController } from "./hooks/use-chat-controller.js";
import { useScrollbackTranscript } from "./hooks/use-scrollback-transcript.js";
import { useTextInput } from "./hooks/use-text-input.js";
import type { ChatSessionSummary, PersistedChatSession } from "./session-store.js";
import {
  STATIC_SLASH_SUGGESTIONS,
  completeSlashCommand,
  getMatchingSuggestions,
  longestCommonPrefix,
  type SlashSuggestion
} from "./slash-commands.js";
import { type ChatMessage } from "./view-models/chat-messages.js";
import { type WelcomeHomeEntry, type WelcomeHomeViewModel } from "./view-models/welcome-home.js";
import {
  buildTodaySummary,
  formatSessionDetailForTui,
  formatSessionRecapForTui,
  formatTodaySummary,
  resolveRuntimeUserId
} from "./view-models/today-summary.js";
import { formatTranscriptForPrint } from "./view-models/scrollback-transcript.js";
import { outputEventsToMarkdown } from "./view-models/transcript-output.js";
import {
  filterSessionIndexEntries,
  movePickerSessionId,
  pickerIndexForSession,
  reconcilePickerSelection
} from "./view-models/session-picker-model.js";

export interface ChatTuiAppProps {
  config: TuiAppConfig;
  cwd: string;
  initialMessages?: ChatMessage[];
  initialSessionApprovalFingerprints?: string[];
  initialSessionTitle?: string;
  initialInteractionMode?: TuiInteractionMode;
  initialRuntimeSessionId?: string;
  initialSessionId?: string;
  reviewerId: string;
  service: TuiRuntimeService;
}

interface ScheduleCommandController {
  activeSessionId: string | null;
  addSystemMessage: (text: string) => void;
}

interface InboxCommandController {
  addSystemMessage: (text: string) => void;
}

interface ScheduleCommandOptions {
  cwd: string;
  providerName: string;
}

export function ChatTuiApp({
  config,
  cwd,
  initialMessages,
  initialSessionApprovalFingerprints,
  initialSessionTitle,
  initialInteractionMode,
  initialRuntimeSessionId,
  initialSessionId,
  reviewerId,
  service
}: ChatTuiAppProps): React.ReactElement {
  const { exit } = useApp();
  const resolvedSessionId = React.useMemo(() => initialSessionId ?? randomUUID(), [initialSessionId]);
  const [sessionTitle, setSessionTitle] = React.useState(initialSessionTitle ?? "assistant");
  const [interactionMode, setInteractionMode] = React.useState<TuiInteractionMode>(
    initialInteractionMode ?? "agent"
  );
  const [sessionPickerOpen, setSessionPickerOpen] = React.useState(false);
  const [sessionIndexEntries, setSessionIndexEntries] = React.useState<SessionIndexEntry[]>([]);
  const [sessionPickerSessionId, setSessionPickerSessionId] = React.useState<string | null>(null);
  const [sessionPickerFilter, setSessionPickerFilter] = React.useState("");
  const [sessionPickerPreviewOpen, setSessionPickerPreviewOpen] = React.useState(false);
  const [recapSessionId, setRecapSessionId] = React.useState<string | null>(null);
  const [approvalSelectionIndex, setApprovalSelectionIndex] = React.useState(0);
  const [clarifySelectionIndex, setClarifySelectionIndex] = React.useState(0);
  const [clarifyQuestionIndex, setClarifyQuestionIndex] = React.useState(0);
  const [clarifyAnswers, setClarifyAnswers] = React.useState<Record<string, string | string[]>>({});
  const [clarifyMultiSelections, setClarifyMultiSelections] = React.useState<Record<number, string[]>>({});
  const [clarifyCustomActive, setClarifyCustomActive] = React.useState(false);
  const [homeSelectionIndex, setHomeSelectionIndex] = React.useState(0);
  const historyRef = React.useRef<string[]>([]);
  const historyIndexRef = React.useRef<number | null>(null);
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionStateRef = React.useRef<{ candidates: string[]; index: number; query: string } | null>(null);
  const scrollbackRef = React.useRef<ReturnType<typeof useScrollbackTranscript> | null>(null);

  const controller = useChatController({
    config,
    cwd,
    ...(initialMessages !== undefined ? { initialMessages } : {}),
    ...(initialSessionApprovalFingerprints !== undefined
      ? { initialSessionApprovalFingerprints }
      : {}),
    ...(initialRuntimeSessionId !== undefined ? { initialSessionId: initialRuntimeSessionId } : { initialSessionId: resolvedSessionId }),
    interactionMode,
    onOutputEvent: (event) => scrollbackRef.current?.onOutputEvent(event),
    onTraceEvent: (event) => scrollbackRef.current?.onTraceEvent(event),
    reviewerId,
    service
  });

  const scrollback = useScrollbackTranscript(controller.messages, config.tui.diffDisplay);
  React.useEffect(() => {
    scrollbackRef.current = scrollback;
  }, [scrollback]);

  const showTodaySummary = React.useMemo(
    () => shouldShowHomeSummary(controller.messages),
    [controller.messages]
  );
  const todaySummaryText = React.useMemo(
    () => formatTodaySummary(buildTodaySummary(service, { activeSessionId: controller.activeSessionId })),
    [controller.activeSessionId, service]
  );
  const activeSessionId = controller.activeSessionId ?? resolvedSessionId;
  const welcomeHome = React.useMemo(
    () => buildWelcomeHomeFromIndex(sessionIndexEntries, activeSessionId),
    [activeSessionId, sessionIndexEntries]
  );
  const homeEntries = welcomeHome.entries;
  const sessionPickerOpenRef = React.useRef(sessionPickerOpen);
  React.useEffect(() => {
    sessionPickerOpenRef.current = sessionPickerOpen;
  }, [sessionPickerOpen]);

  const refreshSessionIndex = React.useCallback(() => {
    if (sessionPickerOpenRef.current) {
      return;
    }
    setSessionIndexEntries(
      service.listSessionIndex({ ownerUserId: reviewerId, status: "active" }).slice(0, 20)
    );
  }, [reviewerId, service]);
  const filteredSessionEntries = React.useMemo(
    () => filterSessionIndexEntries(sessionIndexEntries, sessionPickerFilter),
    [sessionIndexEntries, sessionPickerFilter]
  );
  const sessionPickerSelectedIndex = React.useMemo(
    () => pickerIndexForSession(filteredSessionEntries, sessionPickerSessionId),
    [filteredSessionEntries, sessionPickerSessionId]
  );
  const filteredSessionIds = React.useMemo(
    () => filteredSessionEntries.map((entry) => entry.sessionId).join("\u0000"),
    [filteredSessionEntries]
  );
  const pickerPreviewMessages = React.useMemo(() => {
    if (!sessionPickerPreviewOpen || sessionPickerSessionId === null) {
      return null;
    }
    const uiState = service.loadSessionUiState(sessionPickerSessionId);
    return uiState === null ? null : (uiState.messages as ChatMessage[]);
  }, [service, sessionPickerPreviewOpen, sessionPickerSessionId]);

  const flushActiveSessionState = React.useCallback(
    (overrideTitle?: string) => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const sessionId = controller.activeSessionId;
      if (sessionId === null || controller.busy) {
        return;
      }
      const title = overrideTitle ?? sessionTitle;
      service.saveSessionUiState(sessionId, {
        entrySource: "tui",
        interactionMode,
        messages: controller.messages as never,
        sessionApprovalFingerprints: controller.sessionApprovalFingerprints,
        title
      });
      if (overrideTitle !== undefined) {
        service.updateSessionTitle(sessionId, overrideTitle);
        refreshSessionIndex();
      }
    },
    [
      controller.activeSessionId,
      controller.busy,
      controller.messages,
      controller.sessionApprovalFingerprints,
      interactionMode,
      refreshSessionIndex,
      service,
      sessionTitle
    ]
  );

  const dismissRecap = React.useCallback(() => {
    setRecapSessionId(null);
  }, []);

  const showRecapForSession = React.useCallback((sessionId: string) => {
    setRecapSessionId(sessionId);
  }, []);

  const clearAndStartNewSession = React.useCallback(
    (options?: { newTitle?: string; oldTitle?: string }) => {
      if (
        controller.busy ||
        controller.pendingApproval !== null ||
        controller.pendingClarifyPrompt !== null
      ) {
        controller.addSystemMessage("Finish the active task, approval, or clarification before starting a new session.");
        return null;
      }
      if (controller.activeSessionId !== null && options?.oldTitle !== undefined) {
        flushActiveSessionState(options.oldTitle);
        setSessionTitle(options.oldTitle);
      } else if (controller.activeSessionId !== null) {
        flushActiveSessionState();
      }
      const nextTitle = options?.newTitle ?? "Untitled session";
      const nextId = controller.createAndActivateSession(nextTitle);
      controller.resetVisibleChatPreserveActiveSession("session created");
      setSessionTitle(nextTitle);
      dismissRecap();
      refreshSessionIndex();
      return nextId;
    },
    [controller, dismissRecap, flushActiveSessionState, refreshSessionIndex]
  );

  React.useEffect(() => {
    refreshSessionIndex();
  }, [refreshSessionIndex, activeSessionId]);

  React.useEffect(() => {
    if (!sessionPickerOpen) {
      return;
    }
    const next = reconcilePickerSelection(filteredSessionEntries, sessionPickerSessionId);
    if (next.sessionId !== sessionPickerSessionId) {
      setSessionPickerSessionId(next.sessionId);
    }
  }, [filteredSessionIds, sessionPickerOpen, sessionPickerSessionId]);

  React.useEffect(() => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    if (controller.busy || controller.activeSessionId === null) {
      return;
    }
    saveTimerRef.current = setTimeout(() => {
      service.saveSessionUiState(controller.activeSessionId!, {
        entrySource: "tui",
        interactionMode,
        messages: controller.messages as never,
        sessionApprovalFingerprints: controller.sessionApprovalFingerprints,
        title: sessionTitle
      });
      refreshSessionIndex();
    }, 600);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [
    controller.activeSessionId,
    controller.busy,
    controller.messages,
    controller.sessionApprovalFingerprints,
    interactionMode,
    refreshSessionIndex,
    service,
    sessionTitle
  ]);

  React.useEffect(() => {
    if (controller.pendingApproval !== null) {
      setApprovalSelectionIndex(0);
    }
  }, [controller.pendingApproval?.approvalId]);

  React.useEffect(() => {
    if (controller.pendingClarifyPrompt !== null) {
      setClarifySelectionIndex(0);
      setClarifyQuestionIndex(0);
      setClarifyAnswers({});
      setClarifyMultiSelections({});
      setClarifyCustomActive(false);
    }
  }, [controller.pendingClarifyPrompt?.promptId]);

  React.useEffect(() => {
    setHomeSelectionIndex((current) => clampSelection(current, homeEntries.length));
  }, [homeEntries.length]);

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

  const openExternalEditor = React.useCallback(
    async (value: string): Promise<string> =>
      editInExternalEditor(value, {
        workspaceRoot: config.workspaceRoot
      }),
    [config.workspaceRoot]
  );

  const slashSuggestions = React.useCallback(
    (value: string): SlashSuggestion[] => {
      if (!value.startsWith("/")) {
        return [];
      }
      const dynamicSuggestions = buildDynamicSlashSuggestions(
        value,
        controller.activeSessionId,
        service,
        reviewerId
      );
      return getMatchingSuggestions(value, [...STATIC_SLASH_SUGGESTIONS, ...dynamicSuggestions]);
    },
    [controller.activeSessionId, reviewerId, service]
  );

  const completeInput = React.useCallback(
    (value: string): string | null => {
      const suggestions = slashSuggestions(value);
      if (suggestions.length === 0) {
        completionStateRef.current = null;
        return completeSlashCommand(value);
      }
      const candidates = suggestions.map((item) => item.insertText);
      const previous = completionStateRef.current;
      if (
        previous !== null &&
        previous.query === value &&
        previous.candidates.length === candidates.length &&
        previous.candidates.every((candidate, index) => candidate === candidates[index])
      ) {
        const index = (previous.index + 1) % candidates.length;
        completionStateRef.current = { candidates, index, query: withTrailingSpace(candidates[index] ?? value) };
        return withTrailingSpace(candidates[index] ?? value);
      }
      const common = longestCommonPrefix(candidates);
      const nextValue =
        common.length > value.length
          ? withTrailingSpaceIfExact(common, candidates)
          : withTrailingSpace(candidates[0] ?? value);
      completionStateRef.current = { candidates, index: 0, query: nextValue };
      return nextValue;
    },
    [slashSuggestions]
  );

  const activateSessionById = React.useCallback(
    (sessionId: string): boolean => {
      if (
        controller.busy ||
        controller.pendingApproval !== null ||
        controller.pendingClarifyPrompt !== null
      ) {
        controller.addSystemMessage(
          "Finish the active task, approval, or clarification before resuming another session."
        );
        return false;
      }
      if (controller.activeSessionId !== null && controller.activeSessionId !== sessionId) {
        flushActiveSessionState();
      }
      const activated = controller.activateSession(sessionId);
      if (!activated) {
        return false;
      }
      const uiState = service.loadSessionUiState(sessionId);
      scrollbackRef.current?.replayMessages(
        uiState !== null && uiState.messages.length > 0
          ? (uiState.messages as ChatMessage[])
          : controller.messages
      );
      const session = service.findSession(sessionId);
      setSessionTitle(session?.title ?? "assistant");
      if (uiState !== null) {
        setInteractionMode(uiState.interactionMode);
      }
      setHomeSelectionIndex(0);
      setSessionPickerOpen(false);
      setSessionPickerFilter("");
      setSessionPickerPreviewOpen(false);
      showRecapForSession(sessionId);
      refreshSessionIndex();
      return true;
    },
    [controller, flushActiveSessionState, refreshSessionIndex, service, showRecapForSession]
  );

  const restoreSession = React.useCallback(
    (session: PersistedChatSession): boolean => {
      return activateSessionById(session.sessionId ?? session.id);
    },
    [activateSessionById]
  );

  const runWelcomeEntry = React.useCallback(
    (entry: WelcomeHomeEntry) => {
      activateSessionById(entry.sessionId);
    },
    [activateSessionById]
  );

  const openSessionPicker = React.useCallback(() => {
    const entries = service
      .listSessionIndex({ ownerUserId: reviewerId, status: "active" })
      .slice(0, 20);
    setSessionIndexEntries(entries);
    const initialSelection = reconcilePickerSelection(
      filterSessionIndexEntries(entries, ""),
      activeSessionId
    );
    setSessionPickerSessionId(initialSelection.sessionId);
    setSessionPickerFilter("");
    setSessionPickerPreviewOpen(false);
    setSessionPickerOpen(true);
  }, [activeSessionId, reviewerId, service]);

  const closeSessionPicker = React.useCallback(() => {
    setSessionPickerOpen(false);
    setSessionPickerFilter("");
    setSessionPickerPreviewOpen(false);
  }, []);

  const runSessionPickerEntry = React.useCallback(() => {
    if (sessionPickerSessionId !== null) {
      activateSessionById(sessionPickerSessionId);
    }
  }, [activateSessionById, sessionPickerSessionId]);

  const handleSlashCommand = React.useCallback(
    (text: string): boolean => {
      if (!text.startsWith("/")) {
        return false;
      }

      if (text === "/help") {
        controller.addSystemMessage(
          [
            "Most used: /resume <session> /sessions /today /inbox /new <title> /schedule create <when> | <prompt>",
            "Workflow: /resume <session> /sessions /inbox [show] /next [list|done|block] /commitments [list|done|block] /schedule [list|pause|resume] /memory [review|add|forget|why]",
            "Session: /mode [agent|plan] /edit /status /clear /new [title] /stop /history /context /cost /diff /sandbox /rollback <id|last> /title <name>",
            "File edits: scrollback shows +added/-removed line counts with a folded diff preview; use /diff for more detail.",
            `Diff display: ${config.tui.diffDisplay} (set tui.diffDisplay in runtime.config.json: summary | collapsed | full).`,
            "Ops: use `talon ops` or `talon tui --mode ops` when you need trace, diff, approvals, or runtime diagnostics.",
            "Shortcuts: Enter send | Alt+Enter / Ctrl+J newline | Ctrl+Shift+V paste | Ctrl+O external editor | Alt+P expand pasted draft | Tab slash-complete | Ctrl+P/N history",
            "Saved sessions: use `talon tui --resume <id>` to restore transcript files from .auto-talon/sessions.",
            "Transcript is written to terminal scrollback; use your terminal scrollbar or mouse wheel to review history."
          ].join("\n")
        );
        return true;
      }

      if (text === "/resume" || text.startsWith("/resume ")) {
        void handleResumeCommand(text, controller, {
          loadSession: (id) => {
            const uiState = service.loadSessionUiState(id);
            if (uiState === null) {
              return Promise.resolve(null);
            }
            const session = service.findSession(id);
            return Promise.resolve({
              id,
              interactionMode: uiState.interactionMode,
              messages: uiState.messages as ChatMessage[],
              sessionApprovalFingerprints: uiState.sessionApprovalFingerprints,
              sessionId: id,
              updatedAt: session?.updatedAt ?? new Date().toISOString(),
              ...(session?.title !== undefined ? { title: session.title } : {})
            });
          },
          listSessionSummaries: () =>
            Promise.resolve(service.listSessionIndex({ ownerUserId: reviewerId, status: "active" }).map((entry) => ({
              id: entry.sessionId,
              label: entry.title,
              preview: entry.preview,
              sessionId: entry.sessionId,
              updatedAt: entry.updatedAt
            }))),
          openPicker: openSessionPicker,
          resolveSessionRef: (ref) => {
            const resolved = service.resolveSessionRef(ref, reviewerId);
            return {
              ambiguous: resolved.ambiguous.map((session) => ({
                id: session.sessionId,
                label: session.title
              })),
              sessionId: resolved.session?.sessionId ?? null
            };
          },
          restoreSession
        }).then((resumed) => {
          if (!resumed) {
            refreshSessionIndex();
          }
        });
        return true;
      }

      if (text === "/today") {
        controller.addSystemMessage(todaySummaryText);
        return true;
      }

      if (text === "/inbox" || text.startsWith("/inbox ")) {
        return handleInboxCommand(text, controller, service);
      }

      if (text.startsWith("/next")) {
        return handleNextActionCommand(text, controller, service);
      }

      if (text.startsWith("/commitments")) {
        return handleCommitmentCommand(text, controller, service);
      }

      if (text.startsWith("/memory")) {
        return handleMemoryCommand(text, controller, service, cwd, config.defaultProfileId, reviewerId);
      }

      if (text === "/schedule") {
        return handleScheduleCommand(text, controller, service, {
          cwd,
          providerName: config.provider.name
        });
      }

      if (text.startsWith("/schedule")) {
        return handleScheduleCommand(text, controller, service, {
          cwd,
          providerName: config.provider.name
        });
      }

      if (text === "/ops") {
        controller.addSystemMessage("Open ops with: talon ops (or talon tui --mode ops).");
        return true;
      }

      if (text === "/mode") {
        controller.addSystemMessage(`Current mode: ${interactionMode}. Use /mode plan for read-only planning or /mode agent for normal agent runs.`);
        return true;
      }

      if (text === "/mode plan" || text === "/mode agent") {
        const nextMode = text.endsWith("plan") ? "plan" : "agent";
        setInteractionMode(nextMode);
        controller.addSystemMessage(
          nextMode === "plan"
            ? "Mode set to plan. Future prompts are read-only until you switch back with /mode agent."
            : "Mode set to agent. Future prompts can edit files when the request clearly asks for changes."
        );
        return true;
      }

      if (text === "/transcript" || text.startsWith("/transcript ")) {
        const args = text.trim().split(/\s+/u).slice(1);
        const command = args[0] ?? "print";
        const currentEvents =
          controller.activeSessionId !== null
            ? service.outputSession(controller.activeSessionId)
            : controller.activeTaskId !== null
              ? service.outputTask(controller.activeTaskId)
              : [];
        const scope =
          controller.activeSessionId !== null
            ? `session ${controller.activeSessionId.slice(0, 8)}`
            : controller.activeTaskId !== null
              ? `task ${controller.activeTaskId.slice(0, 8)}`
              : "current session";
        if (command === "export") {
          const format = args[1] === "json" ? "json" : "md";
          const dir = join(config.workspaceRoot, ".auto-talon", "transcripts");
          const file = join(dir, `transcript-${Date.now()}.${format}`);
          void mkdir(dir, { recursive: true })
            .then(() =>
              writeFile(
                file,
                format === "json" ? JSON.stringify(currentEvents, null, 2) : outputEventsToMarkdown(currentEvents),
                "utf8"
              )
            )
            .then(() => controller.addSystemMessage(`Transcript exported: ${file}`))
            .catch((error: unknown) =>
              controller.addSystemMessage(`Transcript export failed: ${error instanceof Error ? error.message : String(error)}`)
            );
          return true;
        }
        if (command === "print" || command === "final" || command === "detail" || command === "search") {
          const mode = command === "detail" ? "detail" : "final";
          const query = command === "search" ? args.slice(1).join(" ") : "";
          scrollback.print(
            formatTranscriptForPrint(currentEvents, {
              mode,
              ...(query.length > 0 ? { query } : {}),
              title: `Transcript ${scope}`
            })
          );
          return true;
        }
        controller.addSystemMessage("Usage: /transcript [print|final|detail|search <query>|export [md|json]]");
        return true;
      }

      if (text === "/edit") {
        return false;
      }

      if (text === "/clear" || text.startsWith("/clear ")) {
        const oldTitle = text === "/clear" ? undefined : text.slice("/clear ".length).trim();
        const nextId = clearAndStartNewSession({
          ...(oldTitle !== undefined && oldTitle.length > 0 ? { oldTitle } : {}),
          newTitle: "Untitled session"
        });
        if (nextId !== null) {
          controller.addSystemMessage(`Started a new session. id=${nextId.slice(0, 8)}`);
        }
        return true;
      }

      if (text === "/new" || text.startsWith("/new ")) {
        const title = text === "/new" ? "Untitled session" : text.slice("/new ".length).trim() || "Untitled session";
        const nextId = clearAndStartNewSession({ newTitle: title });
        if (nextId !== null) {
          controller.addSystemMessage(`Started a new assistant session. id=${nextId.slice(0, 8)} | ${title}`);
        }
        return true;
      }

      if (text === "/branch" || text.startsWith("/branch ")) {
        if (controller.activeSessionId === null) {
          controller.addSystemMessage("No active session to branch.");
          return true;
        }
        const sourceSessionId = controller.activeSessionId;
        const branchTitle = text === "/branch" ? undefined : text.slice("/branch ".length).trim();
        flushActiveSessionState();
        const branched = service.branchSession({
          agentProfileId: config.defaultProfileId,
          cwd,
          ownerUserId: reviewerId,
          sourceSessionId,
          ...(branchTitle !== undefined && branchTitle.length > 0 ? { title: branchTitle } : {})
        });
        activateSessionById(branched.sessionId);
        controller.addSystemMessage(
          `Branched from ${sourceSessionId.slice(0, 8)} into ${branched.sessionId.slice(0, 8)} | ${branched.title}`
        );
        return true;
      }

      if (text === "/handoff" || text.startsWith("/handoff ")) {
        if (controller.activeSessionId === null) {
          controller.addSystemMessage("No active session to hand off.");
          return true;
        }
        const args = text === "/handoff" ? [] : text.slice("/handoff ".length).trim().split(/\s+/u);
        const sub = args[0] ?? "status";
        if (sub === "status") {
          const bindings = service.listGatewayBindingsForRuntimeSession(controller.activeSessionId);
          controller.addSystemMessage(
            bindings.length === 0
              ? "No gateway bindings for this session."
              : bindings
                  .map(
                    (binding) =>
                      `- ${binding.adapterId}:${binding.externalSessionId.slice(0, 12)} -> ${binding.runtimeSessionId?.slice(0, 8) ?? "none"}`
                  )
                  .join("\n")
          );
          return true;
        }
        if (
          controller.busy ||
          controller.pendingApproval !== null ||
          controller.pendingClarifyPrompt !== null
        ) {
          controller.addSystemMessage("Finish the active task, approval, or clarification before handoff.");
          return true;
        }
        flushActiveSessionState();
        const adapterId = sub;
        const externalSessionId = args[1] ?? `${adapterId}:handoff:${controller.activeSessionId.slice(0, 8)}`;
        try {
          const result = service.handoffSession({
            adapterId,
            externalSessionId,
            ownerUserId: reviewerId,
            runtimeSessionId: controller.activeSessionId,
            runtimeUserId: `${adapterId}:session:${externalSessionId}`,
            source: "tui"
          });
          controller.addSystemMessage(
            `Handoff complete to ${adapterId}. Resume locally: ${result.resumeHint}`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          controller.addSystemMessage(`Handoff failed: ${message}`);
        }
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
        openSessionPicker();
        return true;
      }

      if (text === "/dashboard") {
        controller.addSystemMessage("`/dashboard` is a compatibility alias. Use /ops, talon ops, or talon tui --mode ops.");
        return true;
      }

      if (text === "/status") {
        const lines = [
          `session: ${sessionTitle}`,
          `session_id: ${activeSessionId}`,
          `cwd: ${cwd}`,
          `sandbox_mode: ${config.sandbox.mode}`,
          `write_roots: ${config.sandbox.writeRoots.join(", ")}`,
          `model: ${config.provider.model ?? config.provider.name}`,
          `provider: ${config.provider.name}`,
          `reviewer: ${reviewerId}`,
          `mode: ${interactionMode}`,
          `session: ${controller.activeSessionId ?? "(none)"}`,
          `busy: ${controller.busy}`,
          `active_task: ${controller.activeTaskId ?? "(none)"}`,
          `tasks: ${controller.summary.tasks} running: ${controller.summary.runningTasks} approvals: ${controller.summary.pendingApprovals}`,
          `queued_prompts: ${controller.queuedPromptCount}`,
          `status_line: ${controller.statusLine}`,
          `ui_status: ${controller.uiStatus.primaryLabel}`,
          `elapsed: ${controller.runDurationLabel}`,
          "ui_scroll: native_terminal_scrollback",
          `message_rows: ${controller.messages.length}`,
          `tokens_in: ${controller.tokenHud.inputTokens} tokens_out: ${controller.tokenHud.outputTokens}`,
          `context_pct: ${controller.tokenHud.contextPercent} est_cost_usd: ${controller.tokenHud.estimatedCostUsd.toFixed(4)}`,
          "",
          formatSessionDetailForTui(service, activeSessionId)
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
        if (controller.activeSessionId !== null) {
          service.updateSessionTitle(controller.activeSessionId, nextTitle);
          flushActiveSessionState(nextTitle);
        }
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
      activateSessionById,
      openSessionPicker,
      refreshSessionIndex,
      restoreSession,
      service,
      interactionMode,
      sessionTitle,
      activeSessionId,
      scrollback
    ]
  );

  const activeClarifyQuestion =
    controller.pendingClarifyPrompt?.questions[clarifyQuestionIndex] ??
    (controller.pendingClarifyPrompt === null
      ? null
      : {
          allowCustomAnswer: controller.pendingClarifyPrompt.allowCustomAnswer,
          multiSelect: false,
          options: controller.pendingClarifyPrompt.options,
          placeholder: controller.pendingClarifyPrompt.placeholder,
          question: controller.pendingClarifyPrompt.question
        });
  const activeClarifyPrompt =
    controller.pendingClarifyPrompt === null || activeClarifyQuestion === null
      ? null
      : {
          ...controller.pendingClarifyPrompt,
          allowCustomAnswer: activeClarifyQuestion.allowCustomAnswer,
          options: activeClarifyQuestion.options,
          placeholder: activeClarifyQuestion.placeholder,
          question: activeClarifyQuestion.question
        };
  const clarifyQuestionCount = controller.pendingClarifyPrompt?.questions.length ?? 0;
  const activeClarifySelectedOptionIds = clarifyMultiSelections[clarifyQuestionIndex] ?? [];

  const submitClarifyAnswer = React.useCallback(
    (answer: string | string[], legacyOptionId?: string) => {
      const prompt = controller.pendingClarifyPrompt;
      const question = activeClarifyQuestion;
      if (prompt === null || question === null) {
        return;
      }
      const nextAnswers = {
        ...clarifyAnswers,
        [question.question]: answer
      };
      const response = formatClarifyResponse(nextAnswers);
      if (prompt.questions.length <= 1) {
        const legacyInput =
          typeof answer === "string" && legacyOptionId !== undefined && !question.multiSelect
            ? { answerOptionId: legacyOptionId }
            : typeof answer === "string" && legacyOptionId === undefined
              ? { answerText: answer }
              : {};
        void controller.answerPendingClarifyPrompt({
          ...legacyInput,
          answers: nextAnswers,
          response
        });
        return;
      }
      if (clarifyQuestionIndex + 1 < prompt.questions.length) {
        setClarifyAnswers(nextAnswers);
        setClarifyQuestionIndex((current) => current + 1);
        setClarifySelectionIndex(0);
        setClarifyCustomActive(false);
        return;
      }
      void controller.answerPendingClarifyPrompt({ answers: nextAnswers, response });
    },
    [
      activeClarifyQuestion,
      clarifyAnswers,
      clarifyQuestionIndex,
      controller
    ]
  );

  const toggleActiveClarifyOption = React.useCallback(() => {
    const question = activeClarifyQuestion;
    if (question === null || !question.multiSelect) {
      return;
    }
    const option = question.options[clarifySelectionIndex];
    if (option === undefined) {
      return;
    }
    setClarifyMultiSelections((current) => {
      const selected = current[clarifyQuestionIndex] ?? [];
      const nextSelected = selected.includes(option.id)
        ? selected.filter((id) => id !== option.id)
        : [...selected, option.id];
      return {
        ...current,
        [clarifyQuestionIndex]: nextSelected
      };
    });
  }, [activeClarifyQuestion, clarifyQuestionIndex, clarifySelectionIndex]);

  const submitActiveClarifyOptions = React.useCallback(() => {
    const question = activeClarifyQuestion;
    if (question === null) {
      return;
    }
    if (question.multiSelect) {
      const selectedLabels = question.options
        .filter((option) => activeClarifySelectedOptionIds.includes(option.id))
        .map((option) => option.label);
      if (selectedLabels.length > 0) {
        submitClarifyAnswer(selectedLabels);
      }
      return;
    }
    const option = question.options[clarifySelectionIndex];
    if (option !== undefined) {
      submitClarifyAnswer(option.label, option.id);
    }
  }, [
    activeClarifyQuestion,
    activeClarifySelectedOptionIds,
    clarifySelectionIndex,
    submitClarifyAnswer
  ]);

  const activePrompt =
    activeClarifyPrompt !== null
      ? {
          kind: "clarify" as const,
          customActive: clarifyCustomActive,
          optionCount: activeClarifyPrompt.options.length
        }
      : controller.pendingApproval !== null
        ? { kind: "approval" as const }
        : undefined;

  const textInput = useTextInput({
    ...(activePrompt !== undefined ? { activePrompt } : {}),
    busy: controller.busy,
    hasPendingApproval: controller.hasPendingApproval,
    homeSummaryNavigation: {
      enabled:
        showTodaySummary &&
        !sessionPickerOpen &&
        controller.pendingApproval === null &&
        controller.pendingClarifyPrompt === null &&
        homeEntries.length > 0
    },
    sessionPickerNavigation: {
      enabled:
        sessionPickerOpen &&
        controller.pendingApproval === null &&
        controller.pendingClarifyPrompt === null,
      onCancel: closeSessionPicker,
      onFilterAppend: (char) => {
        setSessionPickerFilter((current) => `${current}${char}`);
      },
      onFilterBackspace: () => {
        setSessionPickerFilter((current) => current.slice(0, -1));
      },
      onMove: (delta) => {
        setSessionPickerSessionId((current) =>
          movePickerSessionId(filteredSessionEntries, current, delta)
        );
      },
      onSubmit: runSessionPickerEntry,
      onTogglePreview: () => {
        setSessionPickerPreviewOpen((current) => !current);
      }
    },
    ...(recapSessionId !== null ? { onEscape: dismissRecap } : {}),
    onHistoryNext: navigateHistoryNext,
    onHistoryPrevious: navigateHistoryPrevious,
    onHomeSummaryMove: (delta) => {
      setHomeSelectionIndex((current) => clampSelection(current + delta, homeEntries.length));
    },
    onHomeSummarySubmit: () => {
      const entry = homeEntries[homeSelectionIndex];
      if (entry !== undefined) {
        runWelcomeEntry(entry);
      }
    },
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
    onPromptCtrlC: () => {
      if (controller.pendingClarifyPrompt !== null) {
        controller.cancelPendingClarifyPrompt();
        return;
      }
      if (controller.pendingApproval !== null) {
        void controller.resolvePendingApproval("deny");
      }
    },
    onPromptMove: (delta) => {
      if (controller.pendingApproval !== null) {
        setApprovalSelectionIndex((current) => clampSelection(current + delta, APPROVAL_ACTIONS.length));
        return;
      }
      if (activeClarifyPrompt !== null && !clarifyCustomActive) {
        setClarifySelectionIndex((current) =>
          clampSelection(current + delta, activeClarifyPrompt.options.length)
        );
      }
    },
    onPromptShortcut: (index) => {
      const action = APPROVAL_ACTIONS[index];
      if (action !== undefined) {
        void controller.resolvePendingApproval(action.action, action.scope);
      }
    },
    onPromptSubmit: (value) => {
      if (controller.pendingApproval !== null) {
        const action = APPROVAL_ACTIONS[approvalSelectionIndex] ?? APPROVAL_ACTIONS[0];
        if (action !== undefined) {
          void controller.resolvePendingApproval(action.action, action.scope);
        }
        return;
      }
      if (activeClarifyPrompt !== null) {
        if (clarifyCustomActive) {
          const answerText = value.trim();
          if (answerText.length > 0) {
            submitClarifyAnswer(answerText);
          }
          return;
        }
        submitActiveClarifyOptions();
      }
    },
    onPromptTab: () => {
      if (activeClarifyPrompt?.allowCustomAnswer !== true) {
        return;
      }
      setClarifyCustomActive((current) => !current);
    },
    onPromptToggleSelection: toggleActiveClarifyOption,
    onExternalEditorEdit: openExternalEditor,
    onTabComplete: completeInput,
    onSubmit: (value) => {
      if (value.trim() === "/edit") {
        void openExternalEditor("");
        return true;
      }
      if (controller.busy && value.startsWith("/") && value.trim() !== "/stop") {
        controller.addSystemMessage("Commands are paused while the agent is running. Wait, queue plain text, or use /stop.");
        return false;
      }
      if (handleSlashCommand(value)) {
        return true;
      }
      dismissRecap();
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

  const slashHints = textInput.value.startsWith("/") && textInput.value.length > 0 ? slashSuggestions(textInput.value) : [];

  React.useEffect(() => {
    if (controller.pendingApproval !== null || controller.pendingClarifyPrompt !== null) {
      textInput.clearValue();
    }
  }, [controller.pendingApproval?.approvalId, controller.pendingClarifyPrompt?.promptId]);

  const hasBlockingPrompt = controller.pendingApproval !== null || controller.pendingClarifyPrompt !== null;
  const statusDetails = hasBlockingPrompt
    ? []
    : [
        ...(controller.uiStatus.runState === "running" ? [controller.runDurationLabel] : []),
        ...(controller.uiStatus.runState !== "running" && controller.activeSessionId !== null
          ? [`session ${controller.activeSessionId.slice(0, 8)}`]
          : []),
        `mode ${interactionMode}`
      ];
  const statusHint =
    controller.pendingClarifyPrompt !== null
      ? "Arrows choose, Tab custom, Enter submit"
      : controller.pendingApproval !== null
        ? "1 once, 2 session, 3 always, 4 deny"
        : sessionPickerOpen
          ? "Up/Down + Enter | Type filter | P preview | Esc cancel"
          : recapSessionId !== null
            ? "Esc dismiss recap"
            : showTodaySummary && textInput.value.trim().length === 0 && homeEntries.length > 0
              ? "Up/Down + Enter resume"
              : "";
  const statusMetrics = hasBlockingPrompt
    ? []
    : [
        buildContextMetric(controller.tokenHud.contextPercent, {
          compactedCount: controller.tokenHud.compactedCount,
          microPrunedCount: controller.tokenHud.microPrunedCount
        }),
        ...(controller.usedMemoryCount > 0
          ? [{ label: `mem ${controller.usedMemoryCount}`, tone: "accent" as const }]
          : [])
      ];

  return (
    <Box flexDirection="column">
      <Banner
        details={[config.provider.model ?? config.provider.name, shortenPath(cwd, 20)]}
        productName="AUTOTALON"
        title={sessionTitle === "assistant" ? "Personal Assistant" : sessionTitle}
      />
      {recapSessionId !== null && !sessionPickerOpen ? (
        <SessionRecap recapText={formatSessionRecapForTui(service, recapSessionId)} />
      ) : null}
      {sessionPickerOpen ? (
        <SessionBrowser
          entries={filteredSessionEntries}
          filter={sessionPickerFilter}
          mode="picker"
          previewMessages={pickerPreviewMessages}
          previewOpen={sessionPickerPreviewOpen}
          selectedIndex={sessionPickerSelectedIndex}
        />
      ) : showTodaySummary ? (
        <SessionBrowser
          entries={[]}
          filter=""
          mode="welcome"
          previewMessages={null}
          previewOpen={false}
          selectedIndex={homeSelectionIndex}
          welcomeSummary={welcomeHome}
        />
      ) : null}
      <PromptZone
        approvalPrompt={
          controller.pendingApproval === null
            ? null
            : {
                approval: controller.pendingApproval,
                selectedIndex: approvalSelectionIndex,
                toolCall:
                  service
                    .showTask(controller.pendingApproval.taskId)
                    .toolCalls.find((item) => item.toolCallId === controller.pendingApproval?.toolCallId) ?? null
              }
        }
        clarifyPrompt={
          activeClarifyPrompt === null
            ? null
            : {
                customActive: clarifyCustomActive,
                customLines: textInput.lines,
                prompt: activeClarifyPrompt,
                questionIndex: clarifyQuestionIndex,
                questionCount: clarifyQuestionCount,
                selectedOptionIds: activeClarifySelectedOptionIds,
                selectedIndex: clarifySelectionIndex
              }
        }
      />
      <Box>
        {controller.pendingApproval === null && controller.pendingClarifyPrompt === null ? (
          <InputBox
            busy={controller.busy}
            collapsePreview={textInput.collapsePreview}
            hasPendingApproval={controller.hasPendingApproval}
            isCollapsed={textInput.isCollapsed}
            lines={textInput.lines}
            queuedPromptCount={controller.queuedPromptCount}
            slashHints={slashHints}
            value={textInput.value}
          />
        ) : null}
      </Box>
      <Box>
        <StatusBar
          details={statusDetails}
          hints={[statusHint]}
          metrics={statusMetrics}
          primary={{
            label: formatChatStatusLabel(controller.uiStatus.primaryLabel, {
              pendingApprovalToolName: controller.pendingApproval?.toolName ?? null,
              pendingClarifyPrompt: controller.pendingClarifyPrompt !== null,
              runState: controller.uiStatus.runState
            }),
            tone: controller.uiStatus.primaryTone
          }}
        />
      </Box>
    </Box>
  );
}

function formatChatStatusLabel(
  label: string,
  state: {
    pendingApprovalToolName: string | null;
    pendingClarifyPrompt: boolean;
    runState: string;
  }
): string {
  if (state.pendingApprovalToolName !== null) {
    return `approval: ${state.pendingApprovalToolName}`;
  }
  if (state.pendingClarifyPrompt) {
    return "clarify";
  }
  if (state.runState === "running") {
    return "running";
  }
  return label;
}

function shortenPath(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `...${value.slice(-(maxLength - 3))}`;
}

const APPROVAL_ACTIONS: Array<{ action: "allow" | "deny"; scope?: ApprovalAllowScope }> = [
  { action: "allow", scope: "once" },
  { action: "allow", scope: "session" },
  { action: "allow", scope: "always" },
  { action: "deny" }
];

interface ChatChromeRowsInput {
  activeClarifyPrompt: NonNullable<ReturnType<typeof useChatController>["pendingClarifyPrompt"]> | null;
  collapsePreview: { charCount: number; lineCount: number; previewLines: string[] } | null;
  hasPendingApproval: boolean;
  inputLineCount: number;
  queuedPromptCount: number;
  slashHintCount: number;
  valueLength: number;
}

export function estimateChatChromeRows(input: ChatChromeRowsInput): number {
  const bannerRows = 1;
  const statusRows = 1;
  const promptRows = input.activeClarifyPrompt !== null
    ? estimateClarifyPromptRows(input.activeClarifyPrompt)
    : input.hasPendingApproval
      ? 8
      : estimateInputRows(input);
  return bannerRows + promptRows + statusRows;
}

function estimateInputRows(input: ChatChromeRowsInput): number {
  const baseRows =
    input.valueLength === 0
      ? 1
      : input.collapsePreview !== null
        ? input.collapsePreview.previewLines.length + 1 + (input.collapsePreview.lineCount > input.collapsePreview.previewLines.length ? 1 : 0)
        : Math.max(1, input.inputLineCount);
  const queueRows = input.queuedPromptCount > 0 ? 1 : 0;
  const hintRows = Math.min(6, input.slashHintCount);
  return baseRows + queueRows + hintRows;
}

function estimateClarifyPromptRows(
  prompt: NonNullable<ReturnType<typeof useChatController>["pendingClarifyPrompt"]>
): number {
  const currentQuestion = prompt.questions[0];
  const optionRows = prompt.options.reduce(
    (sum, option) => sum + 1 + (option.description !== undefined ? 1 : 0) + (option.preview !== undefined ? 1 : 0),
    0
  );
  const customRows = prompt.allowCustomAnswer ? 1 : 0;
  return 4 + optionRows + customRows + (currentQuestion?.multiSelect === true ? 0 : 0);
}

function clampSelection(index: number, size: number): number {
  if (size <= 0) {
    return 0;
  }
  if (index < 0) {
    return size - 1;
  }
  if (index >= size) {
    return 0;
  }
  return index;
}

function shouldShowHomeSummary(messages: ChatMessage[]): boolean {
  return messages.every((message) => message.id === "system:welcome");
}

function parseSlashInput(text: string): { args: string[]; command: string; rest: string } {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/u).filter((part) => part.length > 0);
  const command = parts[0] ?? "";
  const args = parts.slice(1);
  const rest = command.length >= trimmed.length ? "" : trimmed.slice(command.length).trim();
  return { args, command, rest };
}

function buildDynamicSlashSuggestions(
  value: string,
  activeSessionId: string | null,
  service: TuiRuntimeService,
  sessionOwnerUserId = resolveRuntimeUserId()
): SlashSuggestion[] {
  const parsed = parseSlashInput(value);
  const userId = resolveRuntimeUserId();

  if (parsed.command === "/resume") {
    return service
      .listSessions("active")
      .filter((item) => item.ownerUserId === sessionOwnerUserId)
      .map((item) => ({
        description: item.title,
        insertText: `/resume ${item.sessionId.slice(0, 8)}`,
        key: `session:${item.sessionId}`,
        label: `/resume ${item.sessionId.slice(0, 8)}`,
        rank: 1
      }));
  }

  if (parsed.command === "/inbox" && parsed.args[0] === "show") {
    return service.listInbox({ status: "pending", userId }).map((item) => ({
      description: item.title,
      insertText: `/inbox show ${item.inboxId.slice(0, 8)}`,
      key: `inbox:${item.inboxId}`,
      label: `/inbox show ${item.inboxId.slice(0, 8)}`,
      rank: 1
    }));
  }

  if (parsed.command === "/schedule" && (parsed.args[0] === "pause" || parsed.args[0] === "resume")) {
    return service.listSchedules({ ownerUserId: userId }).map((item) => ({
      description: item.name,
      insertText: `/schedule ${parsed.args[0]} ${item.scheduleId.slice(0, 8)}`,
      key: `schedule:${item.scheduleId}`,
      label: `/schedule ${parsed.args[0]} ${item.scheduleId.slice(0, 8)}`,
      rank: 1
    }));
  }

  if (parsed.command === "/memory" && (parsed.args[0] === "forget" || parsed.args[0] === "why")) {
    return service.listMemories().map((item) => ({
      description: item.title,
      insertText: `/memory ${parsed.args[0]} ${item.memoryId}`,
      key: `memory:${item.memoryId}`,
      label: `/memory ${parsed.args[0]} ${item.memoryId}`,
      rank: 1
    }));
  }

  if (parsed.command === "/next" && (parsed.args[0] === "done" || parsed.args[0] === "block")) {
    const items = activeSessionId === null ? service.listNextActions() : service.listNextActions({ sessionId: activeSessionId });
    return items.map((item) => ({
      description: item.title,
      insertText: `/next ${parsed.args[0]} ${item.nextActionId.slice(0, 8)}`,
      key: `next:${item.nextActionId}`,
      label: `/next ${parsed.args[0]} ${item.nextActionId.slice(0, 8)}`,
      rank: 1
    }));
  }

  if (parsed.command === "/commitments" && (parsed.args[0] === "done" || parsed.args[0] === "block")) {
    const items = activeSessionId === null ? service.listCommitments() : service.listCommitments({ sessionId: activeSessionId });
    return items.map((item) => ({
      description: item.title,
      insertText: `/commitments ${parsed.args[0]} ${item.commitmentId.slice(0, 8)}`,
      key: `commitment:${item.commitmentId}`,
      label: `/commitments ${parsed.args[0]} ${item.commitmentId.slice(0, 8)}`,
      rank: 1
    }));
  }

  return [];
}

function withTrailingSpace(value: string): string {
  return value.endsWith(" ") ? value : `${value} `;
}

function withTrailingSpaceIfExact(prefix: string, candidates: readonly string[]): string {
  return candidates.includes(prefix) ? withTrailingSpace(prefix) : prefix;
}

function handleMemoryCommand(
  text: string,
  controller: ReturnType<typeof useChatController>,
  service: TuiRuntimeService,
  cwd: string,
  profileId: string,
  reviewerId: string
): boolean {
  const parsed = parseSlashInput(text);
  if (parsed.command !== "/memory") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = parsed.args[0] ?? "";
  if (sub.length === 0) {
    const guidance = [formatMemoryGuide()];
    if (controller.activeTaskId !== null) {
      guidance.push(
        formatMemoryRecallExplanation(service.explainMemoryRecall(controller.activeTaskId))
      );
    }
    controller.addSystemMessage(guidance.join("\n\n"));
    return true;
  }
  if (sub === "review") {
    const items = service.listMemorySuggestions({
      limit: 20,
      status: "pending",
      userId: resolveRuntimeUserId()
    });
    controller.addSystemMessage(formatMemorySuggestionQueue(items));
    return true;
  }
  if (sub === "add") {
    const scope = parsed.args[1];
    const content = parsed.args.slice(2).join(" ").trim();
    if ((scope !== "profile" && scope !== "project") || content.length === 0) {
      controller.addSystemMessage("Usage: /memory add <profile|project> <text>");
      return true;
    }
    try {
      const memory = service.addMemory({
        content,
        cwd,
        profileId,
        reviewerId,
        scope,
        userId: resolveRuntimeUserId()
      });
      controller.addSystemMessage(formatMemoryList([memory]));
    } catch (error) {
      controller.addSystemMessage(error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (sub === "forget") {
    const prefix = parsed.args[1] ?? "";
    if (prefix.length === 0) {
      controller.addSystemMessage("Usage: /memory forget <memory-id-prefix>");
      return true;
    }
    const matches = resolveMemoryByPrefix(prefix, service);
    if (matches.kind !== "one") {
      controller.addSystemMessage(matches.message);
      return true;
    }
    try {
      const memory = service.forgetMemory(matches.item.memoryId, reviewerId, "manual memory forget from TUI");
      controller.addSystemMessage(formatMemoryList([memory]));
    } catch (error) {
      controller.addSystemMessage(error instanceof Error ? error.message : String(error));
    }
    return true;
  }
  if (sub === "why") {
    if (controller.activeTaskId === null) {
      controller.addSystemMessage("No active task is available for memory recall explanation.");
      return true;
    }
    const prefix = parsed.args[1];
    if (prefix === undefined) {
      controller.addSystemMessage(
        formatMemoryRecallExplanation(service.explainMemoryRecall(controller.activeTaskId))
      );
      return true;
    }
    const matches = resolveMemoryByPrefix(prefix, service);
    if (matches.kind !== "one") {
      controller.addSystemMessage(matches.message);
      return true;
    }
    controller.addSystemMessage(
      formatMemoryRecallExplanation(
        service.explainMemoryRecall(controller.activeTaskId, matches.item.memoryId)
      )
    );
    return true;
  }
  controller.addSystemMessage("Usage: /memory | /memory review | /memory add <profile|project> <text> | /memory forget <memory-id-prefix> | /memory why [memory-id-prefix]");
  return true;
}

export function handleInboxCommand(
  text: string,
  controller: InboxCommandController,
  service: Pick<TuiRuntimeService, "listInbox" | "showInboxItem">
): boolean {
  const parsed = parseSlashInput(text);
  if (parsed.command !== "/inbox") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }

  const userId = resolveRuntimeUserId();
  const pendingItems = service
    .listInbox({ status: "pending", userId })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const sub = parsed.args[0] ?? "";
  if (sub.length === 0) {
    const items = pendingItems.slice(0, 20);
    controller.addSystemMessage(
      items.length === 0
        ? `Inbox pending (user=${userId}): none`
        : `Inbox pending (user=${userId}, showing ${items.length}):\n${items
            .map((item) => `- ${item.inboxId.slice(0, 8)} | ${item.title} [${item.status}]`)
            .join("\n")}`
    );
    return true;
  }

  if (sub !== "show") {
    controller.addSystemMessage("Usage: /inbox | /inbox show <inbox-id-prefix>");
    return true;
  }

  const prefix = parsed.args[1] ?? "";
  if (prefix.length === 0) {
    controller.addSystemMessage("Usage: /inbox show <inbox-id-prefix>");
    return true;
  }
  const matches = pendingItems.filter((item) => item.inboxId.startsWith(prefix));
  if (matches.length !== 1) {
    controller.addSystemMessage(
      matches.length === 0
        ? `No pending inbox item matched prefix '${prefix}'.`
        : `Ambiguous inbox prefix '${prefix}':\n${matches
            .map((item) => `- ${item.inboxId.slice(0, 8)} | ${item.title}`)
            .join("\n")}`
    );
    return true;
  }
  const item = service.showInboxItem(matches[0]!.inboxId);
  controller.addSystemMessage(item === null ? `Inbox item ${matches[0]!.inboxId} not found.` : formatInboxDetailForTui(item));
  return true;
}

function formatInboxDetailForTui(item: InboxItem): string {
  const links = [
    item.sessionId === null ? null : `session=${item.sessionId}`,
    item.taskId === null ? null : `task=${item.taskId}`,
    item.approvalId === null ? null : `approval=${item.approvalId}`,
    item.scheduleRunId === null ? null : `schedule_run=${item.scheduleRunId}`,
    item.experienceId === null ? null : `experience=${item.experienceId}`,
    item.skillId === null ? null : `skill=${item.skillId}`
  ].filter((value): value is string => value !== null);
  return [
    `Inbox ${item.inboxId} | ${item.title}`,
    `${item.category} | ${item.severity} | ${item.status}`,
    `Summary: ${item.summary}`,
    ...(item.bodyMd !== null && item.bodyMd.trim().length > 0 ? [`Body:\n${item.bodyMd}`] : []),
    ...(item.actionHint !== null && item.actionHint.trim().length > 0 ? [`Next: ${item.actionHint}`] : []),
    ...(links.length > 0 ? [`Links: ${links.join(" | ")}`] : [])
  ].join("\n");
}

interface ResumeCommandSessionStore {
  listSessionSummaries: () => Promise<ChatSessionSummary[]>;
  loadSession: (id: string) => Promise<PersistedChatSession | null>;
  openPicker: () => void;
  resolveSessionRef?: (ref: string) => { ambiguous: Array<{ id: string; label: string }>; sessionId: string | null };
  restoreSession: (session: PersistedChatSession) => boolean;
}

export async function handleResumeCommand(
  text: string,
  controller: ReturnType<typeof useChatController>,
  sessions: ResumeCommandSessionStore
): Promise<boolean> {
  const parsed = parseSlashInput(text);
  if (parsed.command !== "/resume") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return false;
  }
  const prefix = parsed.rest;
  const summaries = await sessions.listSessionSummaries();
  if (prefix.length === 0) {
    controller.addSystemMessage("Usage: /resume <ref>. Use /sessions to browse.");
    return false;
  }

  let targetId: string | null = null;
  const idMatches = summaries.filter((item) => item.id.startsWith(prefix));
  if (idMatches.length === 1) {
    targetId = idMatches[0]?.id ?? null;
  } else if (idMatches.length > 1) {
    controller.addSystemMessage(
      `Ambiguous session prefix '${prefix}':\n${idMatches.map((item) => `- ${item.id.slice(0, 8)} | ${item.label}`).join("\n")}`
    );
    return false;
  } else if (sessions.resolveSessionRef !== undefined) {
    const resolved = sessions.resolveSessionRef(prefix);
    if (resolved.sessionId !== null) {
      targetId = resolved.sessionId;
    } else if (resolved.ambiguous.length > 0) {
      controller.addSystemMessage(
        `Ambiguous session title '${prefix}':\n${resolved.ambiguous.map((item) => `- ${item.id.slice(0, 8)} | ${item.label}`).join("\n")}`
      );
      return false;
    }
  }

  if (targetId === null) {
    controller.addSystemMessage(`No saved session matched '${prefix}'.`);
    return false;
  }

  const session = await sessions.loadSession(targetId);
  if (session === null) {
    controller.addSystemMessage(`Session ${targetId} could not be loaded.`);
    return false;
  }
  return sessions.restoreSession(session);
}

export function handleScheduleCommand(
  text: string,
  controller: ScheduleCommandController,
  service: Pick<
    TuiRuntimeService,
    "archiveSchedule" | "createSchedule" | "listScheduleRuns" | "listSchedules" | "pauseSchedule" | "resumeSchedule" | "runScheduleNow"
  >,
  options: ScheduleCommandOptions
): boolean {
  const { args, command, rest } = parseSlashInput(text);
  if (command !== "/schedule") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const filter = args[1] ?? "active";
    if (filter !== "active" && filter !== "paused" && filter !== "completed" && filter !== "archived" && filter !== "all") {
      controller.addSystemMessage("Usage: /schedule list [active|paused|completed|archived|all]");
      return true;
    }
    const userId = resolveRuntimeUserId();
    const schedules = service
      .listSchedules({
        ownerUserId: userId,
        ...(filter === "all" ? {} : { status: filter })
      })
      .sort((left, right) => (left.nextFireAt ?? "9999-12-31T23:59:59.999Z").localeCompare(right.nextFireAt ?? "9999-12-31T23:59:59.999Z"))
      .slice(0, 20);
    controller.addSystemMessage(
      schedules.length === 0
        ? `Schedules (${filter}, user=${userId}): none`
        : `Schedules (${filter}, user=${userId}, showing ${schedules.length}):\n${schedules
            .map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name} [${item.status}] | next=${item.nextFireAt ?? "none"}`)
            .join("\n")}`
    );
    return true;
  }
  if (sub === "create") {
    const payload = rest.slice("create".length).trim();
    const separatorIndex = payload.indexOf("|");
    if (separatorIndex <= 0 || separatorIndex === payload.length - 1) {
      controller.addSystemMessage(
        "Usage: /schedule create <when> | <prompt>\nExample: /schedule create 每天 | review inbox"
      );
      return true;
    }
    const whenText = payload.slice(0, separatorIndex).trim();
    const prompt = payload.slice(separatorIndex + 1).trim();
    if (whenText.length === 0 || prompt.length === 0) {
      controller.addSystemMessage(
        "Usage: /schedule create <when> | <prompt>\nExample: /schedule create 今天 18:30 | summarize today"
      );
      return true;
    }
    try {
      const parsed = parseNaturalLanguageScheduleWhen(whenText);
      const schedule = service.createSchedule({
        agentProfileId: "executor",
        cwd: options.cwd,
        input: prompt,
        name: deriveScheduleName(prompt),
        ownerUserId: resolveRuntimeUserId(),
        providerName: options.providerName,
        ...(parsed.cron !== undefined ? { cron: parsed.cron } : {}),
        ...(controller.activeSessionId !== null ? { sessionId: controller.activeSessionId } : {}),
        ...(parsed.every !== undefined ? { every: parsed.every } : {}),
        ...(parsed.runAt !== undefined ? { runAt: parsed.runAt } : {})
      });
      controller.addSystemMessage(
        `Scheduled ${schedule.scheduleId.slice(0, 8)} | ${schedule.name} [${schedule.status}] | next=${schedule.nextFireAt ?? "none"}`
      );
    } catch (error) {
      controller.addSystemMessage(
        `${error instanceof Error ? error.message : String(error)}\nExample: /schedule create 姣忓懆 | prepare weekly review`
      );
    }
    return true;
  }
  if (sub === "pause" || sub === "resume" || sub === "run-now" || sub === "runs" || sub === "remove") {
    const prefix = args[1] ?? "";
    if (prefix.length === 0) {
      controller.addSystemMessage(`Usage: /schedule ${sub} <schedule-id-prefix>`);
      return true;
    }
    const matches = resolveScheduleByPrefix(prefix, service);
    if (matches.kind !== "one") {
      controller.addSystemMessage(matches.message);
      return true;
    }
    if (sub === "runs") {
      const runs = service.listScheduleRuns(matches.item.scheduleId, { tail: 5 });
      controller.addSystemMessage(formatScheduleRunsForTui(runs));
      return true;
    }
    if (sub === "run-now") {
      const run = service.runScheduleNow(matches.item.scheduleId);
      controller.addSystemMessage(formatScheduleRunsForTui([run]));
      return true;
    }
    if (sub === "remove") {
      const archived = service.archiveSchedule(matches.item.scheduleId);
      controller.addSystemMessage(
        `Schedule archived: ${archived.scheduleId.slice(0, 8)} | ${archived.name} [${archived.status}]`
      );
      return true;
    }
    const updated =
      sub === "pause"
        ? service.pauseSchedule(matches.item.scheduleId)
        : service.resumeSchedule(matches.item.scheduleId);
    controller.addSystemMessage(
      `Schedule ${sub}d: ${updated.scheduleId.slice(0, 8)} | ${updated.name} [${updated.status}] | next=${updated.nextFireAt ?? "none"}`
    );
    return true;
  }
  controller.addSystemMessage(
    "Usage: /schedule | /schedule list [active|paused|completed|archived|all] | /schedule create <when> | <prompt> | /schedule pause/resume/run-now/runs/remove <schedule-id-prefix>"
  );
  return true;
}

function formatScheduleRunsForTui(runs: ReturnType<TuiRuntimeService["listScheduleRuns"]>): string {
  if (runs.length === 0) {
    return "Schedule runs: none";
  }
  return `Schedule runs:\n${runs
    .map((run) => `- ${run.runId.slice(0, 8)} | ${run.status} | attempt=${run.attemptNumber} | task=${run.taskId?.slice(0, 8) ?? "-"}`)
    .join("\n")}`;
}

function resolveMemoryByPrefix(
  prefix: string,
  service: TuiRuntimeService
):
  | { item: ReturnType<TuiRuntimeService["listMemories"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const matches = service.listMemories().filter((item) => item.memoryId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No memory matched prefix '${prefix}'.`
        : `Ambiguous memory prefix '${prefix}':\n${matches.map((item) => `- ${item.memoryId} | ${item.title}`).join("\n")}`
  };
}

function resolveScheduleByPrefix(
  prefix: string,
  service: Pick<TuiRuntimeService, "listSchedules">
):
  | { item: ReturnType<TuiRuntimeService["listSchedules"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const userId = resolveRuntimeUserId();
  const matches = service
    .listSchedules({ ownerUserId: userId })
    .filter((item) => item.scheduleId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No schedule matched prefix '${prefix}'.`
        : `Ambiguous schedule prefix '${prefix}':\n${matches.map((item) => `- ${item.scheduleId.slice(0, 8)} | ${item.name}`).join("\n")}`
  };
}

function deriveScheduleName(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u)[0]?.trim() ?? "";
  const normalized = firstLine.length > 0 ? firstLine : "Scheduled routine";
  return normalized.slice(0, 80);
}

function handleNextActionCommand(text: string, controller: ReturnType<typeof useChatController>, service: TuiRuntimeService): boolean {
  const { args, command } = parseSlashInput(text);
  if (command !== "/next") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const requestedSessionPrefix = args[1] ?? "";
    const sessionId = resolveSessionIdForList(controller.activeSessionId, requestedSessionPrefix, service);
    if (sessionId.kind === "error") {
      controller.addSystemMessage(sessionId.message);
      return true;
    }
    const resolvedSessionId = sessionId.sessionId;
    const query =
      resolvedSessionId === null
        ? { statuses: ["active", "pending", "blocked"] as Array<"active" | "pending" | "blocked"> }
        : { sessionId: resolvedSessionId };
    const items = service.listNextActions(query).slice(0, 20);
    const scope = resolvedSessionId === null ? `user=${resolveRuntimeUserId()}` : `session=${resolvedSessionId.slice(0, 8)}`;
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
  const matches = resolveNextActionByPrefix(prefix, controller.activeSessionId, service);
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
  controller.addSystemMessage("Usage: /next [list [session-id-prefix]|done <next-action-id-prefix>|block <next-action-id-prefix> <reason...>]");
  return true;
}

function handleCommitmentCommand(text: string, controller: ReturnType<typeof useChatController>, service: TuiRuntimeService): boolean {
  const { args, command } = parseSlashInput(text);
  if (command !== "/commitments") {
    controller.addSystemMessage(`Unknown command: ${text}. Try /help.`);
    return true;
  }
  const sub = args[0] ?? "list";
  if (sub === "list") {
    const requestedSessionPrefix = args[1] ?? "";
    const sessionId = resolveSessionIdForList(controller.activeSessionId, requestedSessionPrefix, service);
    if (sessionId.kind === "error") {
      controller.addSystemMessage(sessionId.message);
      return true;
    }
    const resolvedSessionId = sessionId.sessionId;
    const query =
      resolvedSessionId === null
        ? {
            ownerUserId: resolveRuntimeUserId(),
            statuses: ["open", "in_progress", "blocked", "waiting_decision"] as Array<
              "open" | "in_progress" | "blocked" | "waiting_decision"
            >
          }
        : { sessionId: resolvedSessionId };
    const items = service.listCommitments(query).slice(0, 20);
    const scope = resolvedSessionId === null ? `user=${resolveRuntimeUserId()}` : `session=${resolvedSessionId.slice(0, 8)}`;
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
  const matches = resolveCommitmentByPrefix(prefix, controller.activeSessionId, service);
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
  controller.addSystemMessage("Usage: /commitments [list [session-id-prefix]|done <commitment-id-prefix>|block <commitment-id-prefix> <reason...>]");
  return true;
}

function resolveSessionIdForList(
  activeSessionId: string | null,
  prefix: string,
  service: TuiRuntimeService
): { kind: "ok"; sessionId: string | null } | { kind: "error"; message: string } {
  if (prefix.length === 0) {
    return { kind: "ok", sessionId: activeSessionId };
  }
  const userId = resolveRuntimeUserId();
  const matches = service
    .listSessions("active")
    .filter((item) => item.ownerUserId === userId && item.sessionId.startsWith(prefix));
  if (matches.length === 1) {
    return { kind: "ok", sessionId: matches[0]!.sessionId };
  }
  return {
    kind: "error",
    message:
      matches.length === 0
        ? `No session matched prefix '${prefix}'.`
        : `Ambiguous session prefix '${prefix}':\n${matches.map((item) => `- ${item.sessionId.slice(0, 8)} | ${item.title}`).join("\n")}`
  };
}

function formatClarifyResponse(answers: Record<string, string | string[]>): string {
  return Object.entries(answers)
    .map(([question, answer]) => {
      const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
      return `${question}\nAnswer: ${answerText}`;
    })
    .join("\n\n");
}

function resolveNextActionByPrefix(
  prefix: string,
  activeSessionId: string | null,
  service: TuiRuntimeService
):
  | { item: ReturnType<TuiRuntimeService["listNextActions"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const items = activeSessionId === null ? service.listNextActions() : service.listNextActions({ sessionId: activeSessionId });
  const matches = items.filter((item) => item.nextActionId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  if (matches.length === 0 && activeSessionId !== null) {
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
  activeSessionId: string | null,
  service: TuiRuntimeService
):
  | { item: ReturnType<TuiRuntimeService["listCommitments"]>[number]; kind: "one" }
  | { kind: "error"; message: string } {
  const items = activeSessionId === null ? service.listCommitments() : service.listCommitments({ sessionId: activeSessionId });
  const matches = items.filter((item) => item.commitmentId.startsWith(prefix));
  if (matches.length === 1) {
    return { item: matches[0]!, kind: "one" };
  }
  if (matches.length === 0 && activeSessionId !== null) {
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

function buildWelcomeHomeFromIndex(
  sessions: SessionIndexEntry[],
  currentSessionId: string
): WelcomeHomeViewModel {
  const entries = sessions
    .filter((session) => session.sessionId !== currentSessionId)
    .slice(0, 4)
    .map((session) => ({
      detail: `${session.source}${session.preview !== null ? ` - ${session.preview}` : ""}`,
      key: `session:${session.sessionId}`,
      label: session.title,
      sessionId: session.sessionId
    }));
  return {
    entries,
    examples:
      entries.length === 0
        ? [
            "Explain this project and point me to the entrypoints.",
            "Fix the failing test and verify the change.",
            "Turn this task into a small implementation plan."
          ]
        : [],
    hint:
      entries.length > 0
        ? "Type a request below, or use Up/Down and Enter to resume a conversation."
        : "Type a request below to start."
  };
}
