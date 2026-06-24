import { PassThrough } from "node:stream";

import { render } from "ink";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  completeApprovalMessage,
  mergeTraceMessages,
  syncPendingApprovalMessages,
  TUI_ACTIVITY_TIMEOUT_MS,
  TUI_INTERACTIVE_MAX_ITERATIONS,
  useChatController,
  type ChatController
} from "../src/tui/hooks/use-chat-controller.js";
import {
  handleInboxCommand,
  handleResumeCommand,
  handleScheduleCommand
} from "../src/tui/chat-app.js";
import {
  canSubmitTextInput,
  deleteCharacterAfter,
  deleteCharacterBefore,
  deletePreviousWord,
  formatTextInputError,
  isReturnKey,
  moveCursorVertical,
  resolveApprovalShortcut
} from "../src/tui/hooks/use-text-input.js";
import { stripAnsi } from "../src/tui/ansi.js";
import { useScrollbackTranscript } from "../src/tui/hooks/use-scrollback-transcript.js";
import { completeSlashCommand } from "../src/tui/slash-commands.js";
import {
  displayChatMessages,
  resolveApprovalMessage,
  toApprovalMessage,
  toTraceActivityMessage,
  type ChatMessage
} from "../src/tui/view-models/chat-messages.js";
import {
  formatScrollbackMessage,
  formatScrollbackOutputEvent,
  formatTranscriptForPrint,
  updateScrollbackToolState,
  wrapScrollbackChunk,
  type ScrollbackToolState,
  type ScrollbackTurnState,
  type ScrollbackWrapState
} from "../src/tui/view-models/scrollback-transcript.js";
import type { AgentApplicationService, AppConfig } from "../src/runtime/index.js";
import { createDefaultRunOptions } from "../src/runtime/index.js";
import { AppError } from "../src/runtime/app-error.js";
import type {
  ApprovalRecord,
  ClarifyPromptRecord,
  InboxItem,
  RuntimeOutputEvent,
  RuntimeRunOptions,
  ScheduleRecord,
  ScheduleRunRecord,
  TaskRecord,
  ToolCallRecord,
  TraceEvent,
  SessionRecord
} from "../src/types/index.js";
import type { CreateScheduleInput } from "../src/runtime/scheduler/index.js";

type ControllerServiceStub = Pick<
  AgentApplicationService,
  | "answerClarifyPrompt"
  | "cancelClarifyPrompt"
  | "listPendingApprovals"
  | "listPendingClarifyPrompts"
  | "listTasks"
  | "continueSession"
  | "providerStats"
  | "createSession"
  | "resolveApproval"
  | "runTask"
  | "showTask"
  | "subscribeToTaskTrace"
  | "traceTask"
>;

function createStubSessionRecord(sessionId: string, title = "Untitled session"): SessionRecord {
  const timestamp = new Date().toISOString();
  return {
    agentProfileId: "executor",
    archivedAt: null,
    createdAt: timestamp,
    cwd: process.cwd(),
    metadata: {},
    ownerUserId: "local-user",
    providerName: "mock",
    sessionId,
    status: "active",
    title,
    updatedAt: timestamp
  };
}

function asControllerService(service: ControllerServiceStub): AgentApplicationService {
  return {
    ensureRuntimeSession: (sessionId, input) =>
      createStubSessionRecord(sessionId, input?.title ?? "Untitled session"),
    getSessionTodos: () => [],
    loadSessionUiState: () => null,
    saveSessionUiState: () => {},
    ...service
  } as AgentApplicationService;
}

type InkRenderResult = ReturnType<typeof render>;

async function unmountInkApp(app: InkRenderResult): Promise<void> {
  const beforeExitListeners = new Set(
    process.rawListeners("beforeExit") as Array<(...args: unknown[]) => void>
  );
  app.unmount();
  await app.waitUntilExit();
  for (const listener of process.rawListeners("beforeExit") as Array<(...args: unknown[]) => void>) {
    if (!beforeExitListeners.has(listener)) {
      process.off("beforeExit", listener);
    }
  }
}

describe("chat tui view-models", () => {
  it("formats trace events into activity messages", () => {
    const event = createTraceEvent("tool_call_started", {
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "write_file"
    });

    const message = toTraceActivityMessage(event);
    expect(message.kind).toBe("activity");
    expect(message.text).toContain("Running write_file");
  });

  it("marks approval message as resolved", () => {
    const approval = createApprovalRecord();
    const toolCall = createToolCallRecord();
    const message = toApprovalMessage(approval, toolCall);
    const resolved = resolveApprovalMessage(message, "allow");

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toBe("allow");
  });

  it("keeps agent replies visible when activity rows are collapsed", () => {
    const agent = {
      id: "agent-1",
      kind: "agent" as const,
      text: "final answer",
      timestamp: "2026-01-01T00:00:01.000Z"
    };
    const activity = toTraceActivityMessage(createTraceEvent("final_outcome", {
      errorCode: null,
      errorMessage: null,
      output: "final answer",
      status: "succeeded"
    }));

    expect(displayChatMessages([agent, activity])).toEqual([agent]);
  });

  it("keeps high-value activity messages visible in chat mode", () => {
    const activity = toTraceActivityMessage(createTraceEvent("tool_call_finished", {
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "write_file",
      summary: "wrote file",
      outputPreview: "ok"
    }));

    const visible = displayChatMessages([activity]);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.kind).toBe("activity");
  });

  it("formats file edit activity with line counts from fileChange", () => {
    const activity = toTraceActivityMessage(createTraceEvent("tool_call_finished", {
      fileChange: {
        addedLineCount: 4,
        changedLineCount: 3,
        path: "src/app.ts",
        removedLineCount: 2,
        unifiedDiffPreview: "--- a/src/app.ts\n+++ b/src/app.ts"
      },
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "write_file",
      summary: "Wrote src/app.ts (+4 -2)",
      outputPreview: "ok"
    }));

    expect(activity.text).toBe("Write src/app.ts (+4 -2)");
  });

  it("treats patch completions as high-value activity", () => {
    const activity = toTraceActivityMessage(createTraceEvent("tool_call_finished", {
      fileChange: {
        addedLineCount: 1,
        changedLineCount: 1,
        path: "src/app.ts",
        removedLineCount: 1,
        unifiedDiffPreview: ""
      },
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "patch",
      summary: "Updated src/app.ts (+1 -1)",
      outputPreview: "ok"
    }));

    expect(displayChatMessages([activity])).toHaveLength(1);
    expect(activity.text).toBe("Write src/app.ts (+1 -1)");
  });

  it("hides successful low-value file reads in chat mode", () => {
    const activity = toTraceActivityMessage(createTraceEvent("tool_call_finished", {
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "read_file",
      summary: "read file",
      outputPreview: "ok"
    }));

    expect(displayChatMessages([activity])).toEqual([]);
  });

  it("collapses repeated high-value activity rows in chat mode", () => {
    const first = toTraceActivityMessage(createTraceEvent("tool_call_finished", {
      iteration: 1,
      outputPreview: "ok",
      summary: "path=D:\\talon-test\\css\\style.css",
      toolCallId: "call-1",
      toolName: "write_file"
    }));
    const second = {
      ...toTraceActivityMessage(createTraceEvent("tool_call_finished", {
        iteration: 2,
        outputPreview: "ok",
        summary: "path=D:\\talon-test\\css\\style.css",
        toolCallId: "call-2",
        toolName: "write_file"
      })),
      text: first.text
    };

    expect(displayChatMessages([first, second])).toEqual([first]);
  });

  it("formats tool execution failures as user-facing task errors", () => {
    const activity = toTraceActivityMessage(createTraceEvent("tool_call_failed", {
      errorCode: "tool_execution_error",
      errorMessage: "ENOENT: no such file or directory, stat 'D:\\talon-test\\food.js'",
      iteration: 1,
      toolCallId: "call-00112233",
      toolName: "read_file"
    }));

    expect(activity.text).toBe(
      "read_file failed while executing the requested action: requested path not found: D:\\talon-test\\food.js. This is a tool error, not an AutoTalon runtime failure."
    );
  });

  it("prints assistant streaming deltas and final completion without duplication", () => {
    const turn: ScrollbackTurnState = { headingWritten: false, printedText: "" };
    const output = [
      formatScrollbackOutputEvent(createOutputEvent("assistant_turn_delta", {
        delta: "Hello",
        display: "provisional",
        iteration: 1,
        turnId: "turn-1"
      }), turn),
      formatScrollbackOutputEvent(createOutputEvent("assistant_turn_delta", {
        delta: " world",
        display: "provisional",
        iteration: 1,
        turnId: "turn-1"
      }), turn),
      formatScrollbackOutputEvent(createOutputEvent("assistant_turn_completed", {
        display: "final",
        iteration: 1,
        text: "Hello world",
        turnId: "turn-1"
      }), turn)
    ].join("");

    expect(stripAnsi(output)).toBe("● AutoTalon\nHello world\n");
  });

  it("prints final assistant completion once when no deltas were emitted", () => {
    const turn: ScrollbackTurnState = { headingWritten: false, printedText: "" };

    expect(
      stripAnsi(
        formatScrollbackOutputEvent(
          createOutputEvent("assistant_turn_completed", {
            display: "final",
            iteration: 1,
            text: "Final answer.",
            turnId: "turn-1"
          }),
          turn
        ) ?? ""
      )
    ).toBe("● AutoTalon\nFinal answer.\n");
  });

  it("does not print hidden assistant completion when no visible delta was emitted", () => {
    const turn: ScrollbackTurnState = { headingWritten: false, printedText: "" };

    expect(formatScrollbackOutputEvent(createOutputEvent("assistant_turn_completed", {
      display: "intermediate",
      iteration: 1,
      text: "hidden tool args",
      transcriptVisibility: "hidden",
      turnId: "turn-1"
    }), turn)).toBeNull();
  });

  it("formats non-assistant messages as append-only scrollback lines", () => {
    expect(
      stripAnsi(
        formatScrollbackMessage({
          id: "user-1",
          kind: "user",
          text: "run tests",
          timestamp: "2026-01-01T00:00:00.000Z"
        }) ?? ""
      )
    ).toBe("\n› run tests\n");
    expect(
      stripAnsi(
        formatScrollbackMessage({
          id: "system-1",
          kind: "system",
          text: "conversation cleared",
          timestamp: "2026-01-01T00:00:00.000Z"
        }) ?? ""
      )
    ).toBe("\u250a conversation cleared\n");
  });

  it("formats persisted agent messages for scrollback replay", () => {
    expect(
      stripAnsi(
        formatScrollbackMessage({
          id: "agent-1",
          kind: "agent",
          text: "Done.",
          timestamp: "2026-01-01T00:00:00.000Z"
        }) ?? ""
      )
    ).toBe("\n● AutoTalon\nDone.\n");
    expect(formatScrollbackMessage({
      id: "agent-stream",
      kind: "agent",
      streaming: true,
      text: "partial",
      timestamp: "2026-01-01T00:00:00.000Z"
    })).toBeNull();
  });

  it("replays session messages including assistant output", async () => {
    const stdout = new PassThrough();
    const chunks: string[] = [];
    stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });
    const sessionMessages: ChatMessage[] = [
      { id: "user-a", kind: "user", text: "Resume me", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "agent-a", kind: "agent", text: "Welcome back.", timestamp: "2026-01-01T00:00:01.000Z" }
    ];
    let scrollback: ReturnType<typeof useScrollbackTranscript> | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useScrollbackTranscript([]);
      React.useEffect(() => {
        scrollback = instance;
      }, [instance]);
      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => scrollback !== null);
      scrollback!.replayMessages(sessionMessages);
      await delay(20);
      scrollback!.replayMessages(sessionMessages);
      await delay(20);
      const output = stripAnsi(chunks.join(""));
      expect(output).toContain("› Resume me");
      expect(output).toContain("● AutoTalon");
      expect(output).toContain("Welcome back.");
      expect(output.match(/● AutoTalon\nWelcome back\./gu)?.length).toBe(2);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("wraps scrollback chunks and buffers incomplete streaming lines", () => {
    const state: ScrollbackWrapState = { column: 0, pending: "" };

    expect(wrapScrollbackChunk("assistant\n12345678901234567890", state, 21)).toBe(
      "assistant\n12345678901234567890\n"
    );
    expect(state.pending).toBe("");

    expect(wrapScrollbackChunk("partial", state, 21)).toBe("");
    expect(state.pending).toBe("partial");
    expect(wrapScrollbackChunk("", state, 21, { flushPartial: true })).toBe("partial\n");
    expect(state.pending).toBe("");
  });

  it("counts CJK text as wide when wrapping scrollback output", () => {
    const state: ScrollbackWrapState = { column: 0, pending: "" };

    expect(wrapScrollbackChunk("\u4E2D\u6587\u4E2D\u6587\u4E2D\u6587\u4E2D\u6587\u4E2D\u6587", state, 21)).toBe("\u4E2D\u6587\u4E2D\u6587\u4E2D\u6587\u4E2D\u6587\u4E2D\u6587\n");
    expect(state.pending).toBe("");
  });

  it("formats file edit trace completion with colored line counts and diff preview", () => {
    const state = new Map<string, ScrollbackToolState>();
    const requested = createTraceEvent("tool_call_requested", {
      input: { path: "src/app.ts" },
      iteration: 1,
      toolCallId: "call-1",
      toolName: "write_file"
    });
    const started = {
      ...createTraceEvent("tool_call_started", {
        iteration: 1,
        toolCallId: "call-1",
        toolName: "write_file"
      }),
      timestamp: "2026-01-01T00:00:00.000Z"
    };
    const finished = {
      ...createTraceEvent("tool_call_finished", {
        fileChange: {
          addedLineCount: 2,
          changedLineCount: 2,
          path: "src/app.ts",
          removedLineCount: 1,
          unifiedDiffPreview: "--- a/src/app.ts\n+++ b/src/app.ts\n-old\n+new"
        },
        iteration: 1,
        outputPreview: "ok",
        summary: "Wrote src/app.ts (+2 -1)",
        toolCallId: "call-1",
        toolName: "write_file"
      }),
      timestamp: "2026-01-01T00:00:00.200Z"
    };

    expect(updateScrollbackToolState(state, requested)).toBeNull();
    expect(updateScrollbackToolState(state, started)).toBeNull();
    const output = updateScrollbackToolState(state, finished);
    expect(output).toContain("\u001b[32m+2\u001b[0m");
    expect(output).toContain("\u001b[31m-1\u001b[0m");
    expect(stripAnsi(output ?? "")).toContain("\u250a \u270d write src/app.ts +2 -1");
    expect(stripAnsi(output ?? "")).toContain("\u250a   -old");
    expect(stripAnsi(output ?? "")).toContain("\u250a   +new");
  });

  it("formats todo trace completion as a compact scrollback line", () => {
    const state = new Map<string, ScrollbackToolState>();
    const requested = createTraceEvent("tool_call_requested", {
      input: {
        merge: true,
        todos: [{ content: "Refactor auth", id: "todo-1", status: "in_progress" }]
      },
      iteration: 1,
      toolCallId: "call-todo",
      toolName: "todo"
    });
    const started = {
      ...createTraceEvent("tool_call_started", {
        iteration: 1,
        toolCallId: "call-todo",
        toolName: "todo"
      }),
      timestamp: "2026-01-01T00:00:00.000Z"
    };
    const finished = {
      ...createTraceEvent("tool_call_finished", {
        iteration: 1,
        outputPreview: "ignored",
        summary: "Updated 1 todo item(s) for session abc",
        todoSnapshot: {
          doneCount: 0,
          totalCount: 1,
          todos: [{ content: "Refactor auth", id: "todo-1", status: "in_progress" }]
        },
        toolCallId: "call-todo",
        toolName: "todo"
      }),
      timestamp: "2026-01-01T00:00:00.300Z"
    };

    updateScrollbackToolState(state, requested);
    updateScrollbackToolState(state, started);
    const output = updateScrollbackToolState(state, finished);
    expect(stripAnsi(output ?? "")).toContain("todo updated");
    expect(stripAnsi(output ?? "")).toContain("0/1 done");
    expect(stripAnsi(output ?? "")).not.toContain("Updated 1 todo item(s)");
  });

  it("keeps elapsed time for non-file tool trace completion", () => {
    const state = new Map<string, ScrollbackToolState>();
    const requested = createTraceEvent("tool_call_requested", {
      input: { command: "npm test" },
      iteration: 1,
      toolCallId: "call-2",
      toolName: "shell"
    });
    const started = {
      ...createTraceEvent("tool_call_started", {
        iteration: 1,
        toolCallId: "call-2",
        toolName: "shell"
      }),
      timestamp: "2026-01-01T00:00:00.000Z"
    };
    const finished = {
      ...createTraceEvent("tool_call_finished", {
        iteration: 1,
        outputPreview: "ok",
        summary: "done",
        toolCallId: "call-2",
        toolName: "shell"
      }),
      timestamp: "2026-01-01T00:00:00.200Z"
    };

    updateScrollbackToolState(state, requested);
    updateScrollbackToolState(state, started);
    expect(updateScrollbackToolState(state, finished)).toBe("\u250a \u25b6 run npm test 0.2s\n");
  });

  it("prints transcript command output to stdout-oriented text instead of opening a viewer", () => {
    const text = formatTranscriptForPrint([
      createOutputEvent("task_input", { input: "question" }),
      {
        ...createOutputEvent("assistant_turn_completed", {
          display: "final",
          iteration: 1,
          text: "answer",
          turnId: "turn-1"
        }),
        sequence: 2
      }
    ], { mode: "detail", title: "Transcript detail" });

    expect(text).toContain("Transcript detail\n");
    expect(text).toContain("#1 user\nquestion");
    expect(text).toContain("#2 assistant\nanswer");
  });
});

describe("use-chat-controller helpers", () => {
  it("merges only unseen trace activity messages", () => {
    const first = createTraceEvent("tool_call_started", {
      iteration: 1,
      toolCallId: "call-1",
      toolName: "shell_exec"
    });
    const second = createTraceEvent("tool_call_finished", {
      iteration: 1,
      outputPreview: "ok",
      summary: "done",
      toolCallId: "call-1",
      toolName: "shell_exec"
    });

    const mergedOnce = mergeTraceMessages([], [first, second]);
    const mergedTwice = mergeTraceMessages(mergedOnce, [first, second]);

    expect(mergedOnce.length).toBe(2);
    expect(mergedTwice.length).toBe(2);
  });

  it("removes stale approval cards from the live transcript", () => {
    const approval = createApprovalRecord();
    const current = [toApprovalMessage(approval, createToolCallRecord())];
    const synced = syncPendingApprovalMessages(
      current,
      [],
      createApprovalLookupService(),
      new Set(current.map((message) => message.id))
    );

    expect(synced.some((message) => message.kind === "approval")).toBe(false);
  });

  it("replaces a completed approval card with a compact result line", () => {
    const approval = createApprovalRecord();
    const current = [toApprovalMessage(approval, createToolCallRecord())];
    const completed = completeApprovalMessage(current, approval, "allow", new Set([current[0]?.id ?? ""]));

    expect(completed.some((message) => message.kind === "approval")).toBe(false);
    expect(completed.at(-1)?.kind).toBe("approval_result");
    expect(completed.at(-1)?.id).toBe("approval-result:approval-1:allow");
  });

  it("queues overlapping prompt submissions and flushes them in order", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createStreamingControllerService();
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let messages: ChatMessage[] = [];

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      React.useEffect(() => {
        messages = instance.messages;
      }, [instance.messages]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before the test submits prompts.");
      }
      expect(submitPrompt("one")).toBe(true);
      expect(submitPrompt("two")).toBe(true);

      await waitFor(() => messages.filter((message) => message.kind === "agent").length === 2);

      expect(
        messages.filter((message) => message.kind === "user").map((message) => message.text)
      ).toEqual(["one", "two"]);
      expect(
        messages.filter((message) => message.kind === "agent").map((message) => message.text)
      ).toEqual(["reply-one", "reply-two"]);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("preserves intermediate assistant turns alongside the final reply", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createMultiTurnControllerService();
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let messages: ChatMessage[] = [];

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      React.useEffect(() => {
        messages = instance.messages;
      }, [instance.messages]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before the test submits prompts.");
      }
      expect(submitPrompt("research")).toBe(true);

      await waitFor(
        () =>
          messages.filter(
            (message) => message.kind === "agent" && message.streaming !== true
          ).length === 2
      );

      const agentReplies = messages
        .filter((message): message is Extract<ChatMessage, { kind: "agent" }> => message.kind === "agent");
      expect(agentReplies.map((message) => message.text)).toEqual([
        "Let me check the README first.",
        "Here is the answer."
      ]);
      expect(agentReplies.every((message) => message.streaming !== true)).toBe(true);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("drops hidden tool-call assistant turns from the visible transcript", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createMultiTurnControllerService({ hiddenIntermediate: true });
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let messages: ChatMessage[] = [];

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      React.useEffect(() => {
        messages = instance.messages;
      }, [instance.messages]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before the test submits prompts.");
      }
      expect(submitPrompt("research")).toBe(true);

      await waitFor(
        () =>
          messages.filter(
            (message) => message.kind === "agent" && message.streaming !== true
          ).length === 1
      );

      const agentReplies = messages
        .filter((message): message is Extract<ChatMessage, { kind: "agent" }> => message.kind === "agent");
      expect(agentReplies.map((message) => message.text)).toEqual(["Here is the answer."]);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("preserves hidden assistant progress when a task fails before a final reply", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createMultiTurnControllerService({
      failAfterHiddenIntermediate: true,
      hiddenIntermediate: true
    });
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let messages: ChatMessage[] = [];

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      React.useEffect(() => {
        messages = instance.messages;
      }, [instance.messages]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before the test submits prompts.");
      }
      expect(submitPrompt("research")).toBe(true);

      await waitFor(() => messages.some((message) => message.kind === "error"));

      const agentReplies = messages
        .filter((message): message is Extract<ChatMessage, { kind: "agent" }> => message.kind === "agent");
      const errors = messages
        .filter((message): message is Extract<ChatMessage, { kind: "error" }> => message.kind === "error");

      expect(agentReplies.map((message) => message.text)).toEqual(["Let me check the README first."]);
      expect(errors[0]?.message).toBe("sandbox denied");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("continues the same session after the first submitted prompt", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const runTask = vi.fn((options: RuntimeRunOptions) => Promise.resolve({
      output: "first-reply",
      task: {
        ...createControllerTask(options),
        finalOutput: "first-reply",
        status: "succeeded",
        sessionId: "session-123"
      }
    }));
    const continueSession = vi.fn((sessionId: string, text: string, overrides?: Partial<RuntimeRunOptions>) => {
      const options = {
        ...createDefaultRunOptions(text, process.cwd(), config),
        ...overrides,
        taskInput: text,
        sessionId
      };
      return Promise.resolve({
        output: "second-reply",
        task: {
          ...createControllerTask(options),
          finalOutput: "second-reply",
          status: "succeeded",
          sessionId
        }
      });
    });
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession,
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask,
      showTask() {
        return {
          approvals: [],
          artifacts: [],
          inboxItems: [],
          scheduleRuns: [],
          task: null,
          toolCalls: [],
          trace: []
        };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let submitPrompt: ChatController["submitPrompt"] | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before submissions.");
      }
      expect(submitPrompt("first")).toBe(true);
      await waitFor(() => runTask.mock.calls.length === 1);
      expect(submitPrompt("second")).toBe(true);
      await waitFor(() => continueSession.mock.calls.length === 1);

      expect(runTask).toHaveBeenCalledTimes(1);
      expect(continueSession).toHaveBeenCalledTimes(1);
      expect(runTask.mock.calls[0]?.[0].maxIterations).toBe(TUI_INTERACTIVE_MAX_ITERATIONS);
      expect(runTask.mock.calls[0]?.[0].timeoutMode).toBe("activity");
      expect(runTask.mock.calls[0]?.[0].timeoutMs).toBe(TUI_ACTIVITY_TIMEOUT_MS);
      expect(continueSession.mock.calls[0]?.[0]).toBe("session-123");
      expect(continueSession.mock.calls[0]?.[1]).toBe("second");
      expect(continueSession.mock.calls[0]?.[2]?.maxIterations).toBe(TUI_INTERACTIVE_MAX_ITERATIONS);
      expect(continueSession.mock.calls[0]?.[2]?.timeoutMode).toBe("activity");
      expect(continueSession.mock.calls[0]?.[2]?.timeoutMs).toBe(TUI_ACTIVITY_TIMEOUT_MS);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("keeps live trace subscription active while a submitted task is busy", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    let capturedOptions: RuntimeRunOptions | null = null;
    let resolveRun: ((value: { output: string; task: TaskRecord }) => void) | null = null;
    let traceListener: ((event: TraceEvent) => void) | null = null;
    let unsubscribeCount = 0;
    let subscribedTaskId: string | null = null;
    const runTask = vi.fn((options: RuntimeRunOptions) => {
      capturedOptions = options;
      return new Promise<{ output: string; task: TaskRecord }>((resolve) => {
        resolveRun = resolve;
      });
    });
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask,
      showTask() {
        return { approvals: [], artifacts: [], inboxItems: [], scheduleRuns: [], task: null, toolCalls: [], trace: [] };
      },
      subscribeToTaskTrace(taskId: string, listener: (event: TraceEvent) => void) {
        subscribedTaskId = taskId;
        traceListener = listener;
        return () => {
          unsubscribeCount += 1;
          traceListener = null;
        };
      },
      traceTask() {
        return [];
      }
    };
    let controller: ChatController | null = null;
    let submitPrompt: ChatController["submitPrompt"] | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
        submitPrompt = instance.submitPrompt;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null && submitPrompt !== null);
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before the test submits prompts.");
      }
      submitPrompt("live trace");
      await waitFor(() => traceListener !== null && subscribedTaskId !== null);
      await delay(20);
      expect(unsubscribeCount).toBe(0);

      traceListener?.({
        ...createTraceEvent("memory_recalled", {
          blockedMemoryIds: [],
          entries: [],
          query: "live trace",
          selectedMemoryIds: ["m1", "m2"],
          selectedScopes: ["project"]
        }),
        sequence: 2,
        taskId: subscribedTaskId ?? "task-live-trace"
      });

      await waitFor(() => controller?.usedMemoryCount === 2);
      if (capturedOptions === null || resolveRun === null) {
        throw new Error("runTask should be pending before resolving the test.");
      }
      resolveRun({
        output: "done",
        task: {
          ...createControllerTask(capturedOptions),
          finalOutput: "done",
          status: "succeeded"
        }
      });
      await waitFor(() => controller?.busy === false);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("uses the latest interaction mode when submitting prompts", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const runTask = vi.fn((options: RuntimeRunOptions) => Promise.resolve({
      output: "planned",
      task: {
        ...createControllerTask(options),
        finalOutput: "planned",
        status: "succeeded"
      }
    }));
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask,
      showTask() {
        return { approvals: [], artifacts: [], inboxItems: [], scheduleRuns: [], task: null, toolCalls: [], trace: [] };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let switchToPlan: (() => void) | null = null;
    let currentMode: "agent" | "plan" = "agent";

    function Harness(): React.ReactElement | null {
      const [interactionMode, setInteractionMode] = React.useState<"agent" | "plan">("agent");
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        interactionMode,
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        currentMode = interactionMode;
        submitPrompt = instance.submitPrompt;
        switchToPlan = () => setInteractionMode("plan");
      }, [instance, interactionMode]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => submitPrompt !== null && switchToPlan !== null);
      switchToPlan?.();
      await waitFor(() => currentMode === "plan");
      if (submitPrompt === null) {
        throw new Error("submitPrompt should be initialized before submissions.");
      }
      expect(submitPrompt("implement the requested feature")).toBe(true);
      await waitFor(() => runTask.mock.calls.length === 1);

      expect(runTask.mock.calls[0]?.[0].agentProfileId).toBe("planner");
      expect(runTask.mock.calls[0]?.[0].metadata?.interactivePromptMode).toBe("tui");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("does not turn an approval suspension into an assistant reply", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const runTask = vi.fn((options: RuntimeRunOptions) => Promise.resolve({
      output: null,
      task: {
        ...createControllerTask(options),
        status: "waiting_approval"
      }
    }));
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask,
      showTask() {
        return { approvals: [], artifacts: [], inboxItems: [], scheduleRuns: [], task: null, toolCalls: [], trace: [] };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });
      React.useEffect(() => {
        controller = instance;
      }, [instance]);
      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };
      expect(getController().submitPrompt("needs approval")).toBe(true);
      await waitFor(
        () =>
          !getController().busy &&
          runTask.mock.calls.length === 1 &&
          getController().messages.some((message) => message.kind === "user" && message.text === "needs approval")
      );

      expect(getController().messages.filter((message) => message.kind === "agent")).toEqual([]);
      expect(getController().messages.filter((message) => message.kind === "user").map((message) => message.text)).toEqual([
        "needs approval"
      ]);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("creates and activates a session before prompt submission", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const runTask = vi.fn((options: RuntimeRunOptions) => Promise.resolve({
      output: "reply",
      task: {
        ...createControllerTask(options),
        finalOutput: "reply",
        status: "succeeded",
        sessionId: options.sessionId ?? null
      }
    }));
    const createSession = vi.fn(() => ({
      agentProfileId: "executor" as const,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      cwd: process.cwd(),
      metadata: {},
      ownerUserId: "local-user",
      providerName: "mock",
      status: "active" as const,
      sessionId: "session-new",
      title: "Untitled session",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }));
    const continueSession = vi.fn((sessionId: string, text: string, overrides?: Partial<RuntimeRunOptions>) => {
      const options = {
        ...createDefaultRunOptions(text, process.cwd(), config),
        ...overrides,
        taskInput: text,
        sessionId
      };
      return Promise.resolve({
        output: "reply",
        task: {
          ...createControllerTask(options),
          finalOutput: "reply",
          status: "succeeded",
          sessionId
        }
      });
    });
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession,
      createSession,
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask,
      showTask() {
        return { approvals: [], artifacts: [], inboxItems: [], scheduleRuns: [], task: null, toolCalls: [], trace: [] };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let submitPrompt: ChatController["submitPrompt"] | null = null;
    let createAndActivateSession: ChatController["createAndActivateSession"] | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });
      React.useEffect(() => {
        submitPrompt = instance.submitPrompt;
        createAndActivateSession = instance.createAndActivateSession;
      }, [instance]);
      return null;
    }
    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });
    try {
      await waitFor(() => submitPrompt !== null && createAndActivateSession !== null);
      createAndActivateSession?.();
      expect(submitPrompt?.("after switch")).toBe(true);
      await waitFor(() => continueSession.mock.calls.length === 1);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(createSession.mock.calls[0]?.[0]).toMatchObject({ ownerUserId: "reviewer" });
      expect(runTask).toHaveBeenCalledTimes(0);
      expect(continueSession.mock.calls[0]?.[0]).toBe("session-new");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("scopes pending approvals and clarify prompts to the active session", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const taskById = new Map<string, TaskRecord>([
      [
        "task-visible",
        createControllerTask({
          ...createDefaultRunOptions("visible", process.cwd(), config),
          taskId: "task-visible",
          sessionId: "session-visible"
        })
      ],
      [
        "task-hidden",
        createControllerTask({
          ...createDefaultRunOptions("hidden", process.cwd(), config),
          taskId: "task-hidden",
          sessionId: "session-hidden"
        })
      ]
    ]);
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [
          {
            ...createApprovalRecord(),
            approvalId: "approval-hidden",
            taskId: "task-hidden"
          }
        ];
      },
      listPendingClarifyPrompts() {
        return [
          {
            ...createClarifyPromptRecord(),
            promptId: "prompt-hidden",
            taskId: "task-hidden"
          }
        ];
      },
      listTasks() {
        return [...taskById.values()];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask() {
        return Promise.reject(new Error("runTask should not be called in this test."));
      },
      showTask(taskId: string) {
        return {
          approvals: [],
          artifacts: [],
          inboxItems: [],
          scheduleRuns: [],
          task: taskById.get(taskId) ?? null,
          toolCalls: [],
          trace: []
        };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionId: "session-visible",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      await delay(20);
      expect(controller?.pendingApproval).toBeNull();
      expect(controller?.pendingClarifyPrompt).toBeNull();
    } finally {
      await unmountInkApp(app);
    }
  });

  it("clears waiting approval status after the user resolves an approval", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const approval = createApprovalRecord();
    const task = {
      ...createControllerTask({
        ...createDefaultRunOptions("resume", process.cwd(), config),
        taskId: approval.taskId,
        sessionId: "session-1"
      }),
      status: "waiting_approval" as const
    };
    let approvalResolved = false;
    const listPendingApprovals = vi.fn((): ApprovalRecord[] => (approvalResolved ? [] : [approval]));
    const resolveApproval = vi.fn(() => {
      approvalResolved = true;
      return Promise.resolve({
        output: "done",
        task: { ...task, finalOutput: "done", status: "succeeded" as const }
      });
    });
    const service: ControllerServiceStub = {
      ...createIdleControllerService(),
      listPendingApprovals,
      listTasks: () => [task],
      resolveApproval,
      showTask: (taskId: string) => ({
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: taskId === task.taskId ? task : null,
        toolCalls: [createToolCallRecord()],
        trace: []
      })
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionId: "session-1",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };

      await waitFor(() => getController().pendingApproval !== null);
      expect(getController().uiStatus.runState).toBe("waiting_approval");

      await getController().resolvePendingApproval("allow");
      await waitFor(
        () =>
          !getController().busy &&
          getController().uiStatus.runState !== "waiting_approval"
      );

      expect(resolveApproval).toHaveBeenCalledTimes(1);
      expect(getController().uiStatus.runState).toBe("succeeded");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("shows running task while an approved task is still resuming", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const approval: ApprovalRecord = {
      ...createApprovalRecord(),
      toolName: "process"
    };
    let taskStatus: TaskRecord["status"] = "waiting_approval";
    const task = () => ({
      ...createControllerTask({
        ...createDefaultRunOptions("resume", process.cwd(), config),
        taskId: approval.taskId,
        sessionId: "session-1"
      }),
      status: taskStatus
    });
    let approvalResolved = false;
    let finishResume: ((result: { output: string | null; task: TaskRecord }) => void) | null = null;
    const resumePromise = new Promise<{ output: string | null; task: TaskRecord }>((resolve) => {
      finishResume = resolve;
    });
    const resolveApproval = vi.fn(() => {
      approvalResolved = true;
      taskStatus = "running";
      return resumePromise;
    });
    const service: ControllerServiceStub = {
      ...createIdleControllerService(),
      listPendingApprovals: () => (approvalResolved ? [] : [approval]),
      listTasks: () => [task()],
      resolveApproval,
      showTask: (taskId: string) => ({
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: taskId === approval.taskId ? task() : null,
        toolCalls: [{ ...createToolCallRecord(), toolName: "process" }],
        trace: []
      })
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionId: "session-1",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });
    let approvalPromise: Promise<void> | null = null;

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };

      await waitFor(() => getController().pendingApproval?.toolName === "process");
      approvalPromise = getController().resolvePendingApproval("allow");
      await waitFor(() => getController().uiStatus.primaryLabel === "running task");

      expect(resolveApproval).toHaveBeenCalledTimes(1);
      expect(getController().uiStatus).toMatchObject({
        primaryLabel: "running task",
        runState: "running"
      });
    } finally {
      taskStatus = "succeeded";
      finishResume?.({ output: "done", task: { ...task(), finalOutput: "done", status: "succeeded" } });
      if (approvalPromise !== null) {
        await approvalPromise.catch(() => undefined);
      }
      await unmountInkApp(app);
    }
  });

  it("syncs the next pending approval after the user resolves one approval", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const firstApproval = createApprovalRecord();
    const secondApproval: ApprovalRecord = {
      ...createApprovalRecord(),
      approvalId: "approval-2",
      reason: "Need to run a shell command",
      toolCallId: "call-002",
      toolName: "shell"
    };
    const task = {
      ...createControllerTask({
        ...createDefaultRunOptions("resume", process.cwd(), config),
        taskId: firstApproval.taskId,
        sessionId: "session-1"
      }),
      status: "waiting_approval" as const
    };
    const firstToolCall = createToolCallRecord();
    const secondToolCall: ToolCallRecord = {
      ...createToolCallRecord(),
      toolCallId: "call-002",
      toolName: "shell"
    };
    let pendingApprovals: ApprovalRecord[] = [firstApproval];
    const resolveApproval = vi.fn(() => {
      pendingApprovals = [secondApproval];
      return Promise.resolve({
        output: null,
        task: { ...task, status: "waiting_approval" as const }
      });
    });
    const service: ControllerServiceStub = {
      ...createIdleControllerService(),
      listPendingApprovals: () => pendingApprovals,
      listTasks: () => [task],
      resolveApproval,
      showTask: (taskId: string) => ({
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: taskId === task.taskId ? task : null,
        toolCalls: [firstToolCall, secondToolCall],
        trace: []
      })
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionId: "session-1",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };

      await waitFor(() => getController().pendingApproval?.approvalId === firstApproval.approvalId);
      expect(getController().pendingApproval?.toolName).toBe("write_file");

      await getController().resolvePendingApproval("allow");
      await waitFor(() => getController().pendingApproval?.approvalId === secondApproval.approvalId);

      expect(resolveApproval).toHaveBeenCalledTimes(1);
      expect(getController().pendingApproval?.toolName).toBe("shell");
      expect(getController().uiStatus).toMatchObject({
        primaryLabel: "approval required: shell",
        runState: "waiting_approval"
      });
    } finally {
      await unmountInkApp(app);
    }
  });

  it("resets the visible transcript without abandoning the active session", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createIdleControllerService();
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionApprovalFingerprints: ["fingerprint-1"],
        initialSessionId: "session-active",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      if (controller === null) {
        throw new Error("Controller did not initialize.");
      }
      const activeController: {
        activeSessionId: string | null;
        addSystemMessage: (text: string) => void;
        messages: ChatMessage[];
        resetVisibleChatPreserveActiveSession: () => void;
        sessionApprovalFingerprints: string[];
      } = controller;
      activeController.addSystemMessage("before clear");
      await delay(20);
      activeController.resetVisibleChatPreserveActiveSession();
      await delay(20);

      expect(activeController.activeSessionId).toBe("session-active");
      expect(activeController.sessionApprovalFingerprints).toEqual(["fingerprint-1"]);
      expect(activeController.messages).toHaveLength(1);
      expect(activeController.messages[0]?.id).toBe("system:welcome");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("clears the visible transcript and abandons the active session without dropping session approvals", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createIdleControllerService();
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionApprovalFingerprints: ["fingerprint-1"],
        initialSessionId: "session-active",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };
      getController().addSystemMessage("before clear");
      await delay(20);
      getController().resetVisibleChat();
      await waitFor(() => getController().activeSessionId === null);

      expect(getController().sessionApprovalFingerprints).toEqual(["fingerprint-1"]);
      expect(getController().messages).toHaveLength(1);
      expect(getController().messages[0]?.id).toBe("system:welcome");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("hydrates a saved session into the active controller", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service = createIdleControllerService();
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });
      React.useEffect(() => {
        controller = instance;
      }, [instance]);
      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };
      const activeController = getController();
      activeController.restoreSession({
        id: "session-resume",
        messages: [
          { id: "user:resume", kind: "user", text: "Resume me", timestamp: "2026-01-01T00:00:00.000Z" },
          { id: "agent:resume", kind: "agent", text: "Back again.", timestamp: "2026-01-01T00:00:01.000Z" }
        ],
        sessionApprovalFingerprints: ["resume-fingerprint"],
        sessionId: "session-resume",
        updatedAt: "2026-01-01T01:00:00.000Z"
      });
      await waitFor(() => getController().activeSessionId === "session-resume");

      expect(getController().messages).toMatchObject([
        { kind: "user", text: "Resume me" },
        { kind: "agent", text: "Back again." }
      ]);
      expect(getController().sessionApprovalFingerprints).toEqual(["resume-fingerprint"]);
      expect(getController().uiStatus.primaryLabel).toBe("session resumed");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("hydrates failed progress from output events for legacy sessions", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const taskId = "failed-task";
    const service = {
      ...createIdleControllerService(),
      outputTask(id: string): RuntimeOutputEvent[] {
        expect(id).toBe(taskId);
        return [
          {
            eventId: "output-1",
            eventType: "assistant_turn_completed",
            payload: {
              display: "intermediate",
              iteration: 1,
              text: "Recovered hidden progress.",
              transcriptVisibility: "hidden",
              turnId: "turn-1"
            },
            sequence: 1,
            stage: "planning",
            taskId,
            sessionId: "session-resume",
            timestamp: "2026-01-01T00:00:01.000Z"
          },
          {
            eventId: "output-2",
            eventType: "error",
            payload: {
              code: "sandbox_denied",
              message: "sandbox denied",
              status: "failed"
            },
            sequence: 2,
            stage: "completion",
            taskId,
            sessionId: "session-resume",
            timestamp: "2026-01-01T00:00:02.000Z"
          }
        ];
      }
    };
    let controller: ChatController | null = null;
    let messages: ChatMessage[] = [];

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });
      React.useEffect(() => {
        controller = instance;
      }, [instance]);
      React.useEffect(() => {
        messages = instance.messages;
      }, [instance.messages]);
      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      const getController = (): ChatController => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };
      getController().restoreSession({
        id: "session-resume",
        messages: [
          {
            id: "user:resume",
            kind: "user",
            text: "Resume me",
            timestamp: "2026-01-01T00:00:00.000Z"
          },
          {
            code: "sandbox_denied",
            id: `error:${taskId}:error-1`,
            kind: "error",
            message: "sandbox denied",
            source: "runtime",
            timestamp: "2026-01-01T00:00:02.000Z"
          }
        ],
        sessionId: "session-resume",
        updatedAt: "2026-01-01T01:00:00.000Z"
      });
      await waitFor(() => messages.some((message) => message.kind === "agent"));

      expect(messages.map((message) => message.kind)).toEqual(["user", "agent", "error"]);
      expect(
        messages.find((message): message is Extract<ChatMessage, { kind: "agent" }> => message.kind === "agent")?.text
      ).toBe("Recovered hidden progress.");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("surfaces clarify answer failures in the transcript", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const prompt = {
      ...createClarifyPromptRecord(),
      taskId: "task-visible"
    };
    const task = createControllerTask({
      ...createDefaultRunOptions("clarify", process.cwd(), config),
      taskId: "task-visible",
      sessionId: "session-visible"
    });
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        return Promise.reject(new Error("clarify failed"));
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [prompt];
      },
      listTasks() {
        return [task];
      },
      providerStats() {
        return null;
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask() {
        return Promise.reject(new Error("runTask should not be called in this test."));
      },
      showTask() {
        return {
          approvals: [],
          artifacts: [],
          inboxItems: [],
          scheduleRuns: [],
          task,
          toolCalls: [],
          trace: []
        };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionId: "session-visible",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller?.pendingClarifyPrompt?.promptId === "prompt-1");
      if (controller === null) {
        throw new Error("Controller did not initialize.");
      }
      const getController = (): {
        answerPendingClarifyPrompt: (payload: { answerText: string }) => Promise<void>;
        messages: ChatMessage[];
      } => {
        if (controller === null) {
          throw new Error("Controller did not initialize.");
        }
        return controller;
      };
      await getController().answerPendingClarifyPrompt({ answerText: "hello" });
      await waitFor(() =>
        getController().messages.some(
          (message) => message.kind === "error" && message.message.includes("clarify failed")
        )
      );

      const errorMessage = [...getController().messages]
        .reverse()
        .find((message) => message.kind === "error");
      expect(errorMessage?.kind).toBe("error");
      expect(errorMessage?.message).toContain("clarify failed");
    } finally {
      await unmountInkApp(app);
    }
  });

  it("starts token HUD at zero for a fresh connection with trace-only stats", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return {
          averageLatencyMs: 42,
          failedRequests: 0,
          lastErrorCategory: null,
          lastRequestAt: "2026-01-01T00:00:00.000Z",
          providerName: "mock",
          retryCount: 0,
          source: "trace" as const,
          successfulRequests: 12,
          tokenUsage: {
            inputTokens: 50_000,
            outputTokens: 25_000,
            totalTokens: 75_000
          },
          totalRequests: 12
        };
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask() {
        return Promise.reject(new Error("runTask should not be called in this test."));
      },
      showTask() {
        return {
          approvals: [],
          artifacts: [],
          inboxItems: [],
          scheduleRuns: [],
          task: null,
          toolCalls: [],
          trace: []
        };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      await delay(20);
      if (controller === null) {
        throw new Error("Controller did not initialize.");
      }
      const activeController: {
        tokenHud: {
          contextPercent: number;
          inputTokens: number;
          outputTokens: number;
        };
      } = controller;
      expect(activeController.tokenHud.inputTokens).toBe(0);
      expect(activeController.tokenHud.outputTokens).toBe(0);
      expect(activeController.tokenHud.contextPercent).toBe(0);
    } finally {
      await unmountInkApp(app);
    }
  });

  it("shows trace token HUD when resuming with session_total usage mode", async () => {
    const stdout = new PassThrough();
    const config = createControllerConfig();
    const service: ControllerServiceStub = {
      answerClarifyPrompt() {
        throw new Error("answerClarifyPrompt should not be called in this test.");
      },
      cancelClarifyPrompt() {
        throw new Error("cancelClarifyPrompt should not be called in this test.");
      },
      continueSession() {
        return Promise.reject(new Error("continueSession should not be called in this test."));
      },
      createSession() {
        throw new Error("createSession should not be called in this test.");
      },
      listPendingApprovals() {
        return [];
      },
      listPendingClarifyPrompts() {
        return [];
      },
      listTasks() {
        return [];
      },
      providerStats() {
        return {
          averageLatencyMs: 42,
          failedRequests: 0,
          lastErrorCategory: null,
          lastRequestAt: "2026-01-01T00:00:00.000Z",
          providerName: "mock",
          retryCount: 0,
          source: "trace" as const,
          successfulRequests: 12,
          tokenUsage: {
            inputTokens: 50_000,
            outputTokens: 25_000,
            totalTokens: 75_000
          },
          totalRequests: 12
        };
      },
      resolveApproval() {
        throw new Error("resolveApproval should not be called in this test.");
      },
      runTask() {
        return Promise.reject(new Error("runTask should not be called in this test."));
      },
      showTask() {
        return {
          approvals: [],
          artifacts: [],
          inboxItems: [],
          scheduleRuns: [],
          task: null,
          toolCalls: [],
          trace: []
        };
      },
      subscribeToTaskTrace() {
        return () => {};
      },
      traceTask() {
        return [];
      }
    };
    let controller: ChatController | null = null;

    function Harness(): React.ReactElement | null {
      const instance = useChatController({
        config,
        cwd: process.cwd(),
        initialSessionId: "session-resume",
        reviewerId: "reviewer",
        service: asControllerService(service)
      });

      React.useEffect(() => {
        controller = instance;
      }, [instance]);

      return null;
    }

    const app = render(React.createElement(Harness), {
      interactive: false,
      patchConsole: false,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    try {
      await waitFor(() => controller !== null);
      await delay(20);
      if (controller === null) {
        throw new Error("Controller did not initialize.");
      }
      const tokenHud: ChatController["tokenHud"] = (controller as ChatController).tokenHud;
      expect(tokenHud.inputTokens).toBe(50_000);
      expect(tokenHud.outputTokens).toBe(25_000);
      expect(tokenHud.usageMode).toBe("session_total");
      expect(tokenHud.contextPercent).toBeGreaterThan(0);
    } finally {
      await unmountInkApp(app);
    }
  });
});

describe("use-text-input helpers", () => {
  it("moves cursor up preserving preferred column", () => {
    const value = "abcd\na\nabcdef";
    const startIndex = value.length;

    const firstUp = moveCursorVertical(value, startIndex, -1, null);
    const secondUp = moveCursorVertical(value, firstUp.index, -1, firstUp.preferredColumn);

    expect(firstUp.index).toBe("abcd\na".length);
    expect(secondUp.index).toBe("abcd".length);
  });

  it("moves cursor down and clamps to shorter lines", () => {
    const value = "abcdef\nab\nabcdef";
    const start = "abc".length;
    const down = moveCursorVertical(value, start, 1, null);
    const downAgain = moveCursorVertical(value, down.index, 1, down.preferredColumn);

    expect(down.index).toBe("abcdef\nab".length);
    expect(downAgain.index).toBe("abcdef\nab\nabc".length);
  });

  it("deletes previous word with ctrl+w behavior", () => {
    const result = deletePreviousWord("hello brave world", "hello brave world".length);
    expect(result.value).toBe("hello brave ");
    expect(result.cursorIndex).toBe("hello brave ".length);
  });

  it("deletes trailing whitespace and previous word", () => {
    const result = deletePreviousWord("hello brave   ", "hello brave   ".length);
    expect(result.value).toBe("hello ");
    expect(result.cursorIndex).toBe("hello ".length);
  });

  it("deletes the character before the cursor for backspace", () => {
    const result = deleteCharacterBefore("abc", 2);
    expect(result.value).toBe("ac");
    expect(result.cursorIndex).toBe(1);
  });

  it("deletes a full emoji grapheme for backspace", () => {
    const value = "A\u{1F469}\u{1F3FD}\u200D\u{1F4BB}B";
    const cursorIndex = "A\u{1F469}\u{1F3FD}\u200D\u{1F4BB}".length;
    const result = deleteCharacterBefore(value, cursorIndex);
    expect(result.value).toBe("AB");
    expect(result.cursorIndex).toBe(1);
  });

  it("deletes the character after the cursor for delete", () => {
    const result = deleteCharacterAfter("abc", 1);
    expect(result.value).toBe("ac");
    expect(result.cursorIndex).toBe(1);
  });

  it("deletes a full emoji grapheme for delete", () => {
    const value = "A\u{1F469}\u{1F3FD}\u200D\u{1F4BB}B";
    const result = deleteCharacterAfter(value, 1);
    expect(result.value).toBe("AB");
    expect(result.cursorIndex).toBe(1);
  });

  it("resolves approval shortcuts when input box only has whitespace", () => {
    expect(resolveApprovalShortcut("a", "   \n\t", true)).toBe("allow");
    expect(resolveApprovalShortcut("D", "  ", true)).toBe("deny");
  });

  it("ignores approval shortcuts when prompt has non-whitespace text", () => {
    expect(resolveApprovalShortcut("a", " draft", true)).toBeNull();
    expect(resolveApprovalShortcut("d", "", false)).toBeNull();
  });

  it("allows queued submissions while busy", () => {
    expect(canSubmitTextInput("/stop", true)).toBe(true);
    expect(canSubmitTextInput(" /stop ", true)).toBe(true);
    expect(canSubmitTextInput("hello", true)).toBe(true);
    expect(canSubmitTextInput("hello", false)).toBe(true);
    expect(canSubmitTextInput("   ", false)).toBe(false);
  });

  it("recognizes raw terminal return input as Enter", () => {
    expect(isReturnKey("", { return: true })).toBe(true);
    expect(isReturnKey("\r", {})).toBe(true);
    expect(isReturnKey("\n", {})).toBe(true);
    expect(isReturnKey("x", {})).toBe(false);
  });

  it("formats input errors with actionable context", () => {
    expect(formatTextInputError("Clipboard read failed", new Error("permission denied"))).toBe(
      "Clipboard read failed: permission denied"
    );
    expect(formatTextInputError("Submit failed", "timeout")).toBe("Submit failed: timeout");
    expect(formatTextInputError("External editor failed", "")).toBe("External editor failed");
  });

  it("completes new memory slash commands", () => {
    expect(completeSlashCommand("/mem")).toBe("/memory ");
    expect(completeSlashCommand("/memory a")).toBe("/memory add ");
  });

  it("completes model slash commands", () => {
    expect(completeSlashCommand("/model")).toBe("/model ");
    expect(completeSlashCommand("/model l")).toBeNull();
  });
});

describe("schedule slash command helper", () => {
  type ScheduleCommandService = Parameters<typeof handleScheduleCommand>[2];

  it("creates schedules with the active session", () => {
    const messages: string[] = [];
    const createSchedule = vi.fn((input: CreateScheduleInput) => ({
      ...createScheduleRecord("schedule-1"),
      name: input.name,
      nextFireAt: input.runAt ?? "2026-01-01T10:00:00.000Z",
      sessionId: input.sessionId ?? null
    }));
    const handled = handleScheduleCommand(
      "/schedule create 每天 | review inbox",
      {
        activeSessionId: "session-123",
        addSystemMessage: (text) => messages.push(text)
      },
      {
        createSchedule,
        listSchedules: () => [],
        pauseSchedule: vi.fn(),
        resumeSchedule: vi.fn()
      } as unknown as ScheduleCommandService,
      {
        cwd: process.cwd(),
        providerName: "mock"
      }
    );

    expect(handled).toBe(true);
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        every: "1d",
        input: "review inbox",
        sessionId: "session-123"
      })
    );
    expect(messages[0]).toContain("Scheduled");
  });

  it("lists schedules with status filters and resolves pause/resume by prefix", () => {
    const messages: string[] = [];
    const schedules = [
      createScheduleRecord("schedule-12345678"),
      {
        ...createScheduleRecord("schedule-abcdef12"),
        status: "paused" as const
      }
    ];
    const pauseSchedule = vi.fn(() => ({ ...schedules[0]!, status: "paused" as const }));
    const resumeSchedule = vi.fn(() => ({ ...schedules[1]!, status: "active" as const }));
    handleScheduleCommand(
      "/schedule list all",
      {
        activeSessionId: null,
        addSystemMessage: (text) => messages.push(text)
      },
      {
        createSchedule: vi.fn(),
        listSchedules: () => schedules,
        pauseSchedule,
        resumeSchedule
      } as unknown as ScheduleCommandService,
      {
        cwd: process.cwd(),
        providerName: "mock"
      }
    );
    handleScheduleCommand(
      "/schedule pause schedule-12",
      {
        activeSessionId: null,
        addSystemMessage: (text) => messages.push(text)
      },
      {
        createSchedule: vi.fn(),
        listSchedules: () => schedules,
        pauseSchedule,
        resumeSchedule
      } as unknown as ScheduleCommandService,
      {
        cwd: process.cwd(),
        providerName: "mock"
      }
    );
    handleScheduleCommand(
      "/schedule resume schedule-ab",
      {
        activeSessionId: null,
        addSystemMessage: (text) => messages.push(text)
      },
      {
        createSchedule: vi.fn(),
        listSchedules: () => schedules,
        pauseSchedule,
        resumeSchedule
      } as unknown as ScheduleCommandService,
      {
        cwd: process.cwd(),
        providerName: "mock"
      }
    );

    expect(messages[0]).toContain("Schedules (all");
    expect(pauseSchedule).toHaveBeenCalledWith("schedule-12345678");
    expect(resumeSchedule).toHaveBeenCalledWith("schedule-abcdef12");
  });

  it("supports run-now, runs, and remove lifecycle commands", () => {
    const messages: string[] = [];
    const schedules = [createScheduleRecord("schedule-12345678")];
    const runScheduleNow = vi.fn(() => createScheduleRunRecord("run-now-1", schedules[0]!.scheduleId));
    const listScheduleRuns = vi.fn(() => [createScheduleRunRecord("run-old-1", schedules[0]!.scheduleId)]);
    const archiveSchedule = vi.fn(() => ({ ...schedules[0]!, status: "archived" as const }));
    const service = {
      archiveSchedule,
      createSchedule: vi.fn(),
      listScheduleRuns,
      listSchedules: () => schedules,
      pauseSchedule: vi.fn(),
      resumeSchedule: vi.fn(),
      runScheduleNow
    } as unknown as ScheduleCommandService;

    for (const command of [
      "/schedule run-now schedule-12",
      "/schedule runs schedule-12",
      "/schedule remove schedule-12"
    ]) {
      handleScheduleCommand(
        command,
        {
          activeSessionId: null,
          addSystemMessage: (text) => messages.push(text)
        },
        service,
        {
          cwd: process.cwd(),
          providerName: "mock"
        }
      );
    }

    expect(runScheduleNow).toHaveBeenCalledWith("schedule-12345678");
    expect(listScheduleRuns).toHaveBeenCalledWith("schedule-12345678", { tail: 5 });
    expect(archiveSchedule).toHaveBeenCalledWith("schedule-12345678");
    expect(messages.join("\n")).toContain("Schedule runs:");
    expect(messages.join("\n")).toContain("Schedule archived");
  });

  it("reports usage and ambiguity errors", () => {
    const messages: string[] = [];
    const schedules = [createScheduleRecord("schedule-1111"), createScheduleRecord("schedule-1122")];
    handleScheduleCommand(
      "/schedule create invalid",
      {
        activeSessionId: null,
        addSystemMessage: (text) => messages.push(text)
      },
      {
        createSchedule: vi.fn(),
        listSchedules: () => schedules,
        pauseSchedule: vi.fn(),
        resumeSchedule: vi.fn()
      } as unknown as ScheduleCommandService,
      {
        cwd: process.cwd(),
        providerName: "mock"
      }
    );
    handleScheduleCommand(
      "/schedule pause schedule-11",
      {
        activeSessionId: null,
        addSystemMessage: (text) => messages.push(text)
      },
      {
        createSchedule: vi.fn(),
        listSchedules: () => schedules,
        pauseSchedule: vi.fn(),
        resumeSchedule: vi.fn()
      } as unknown as ScheduleCommandService,
      {
        cwd: process.cwd(),
        providerName: "mock"
      }
    );

    expect(messages[0]).toContain("Usage: /schedule create");
    expect(messages[1]).toContain("Ambiguous schedule prefix");
  });
});

describe("resume slash command helper", () => {
  it("shows usage when no ref is provided", async () => {
    const messages: string[] = [];
    const resets: string[] = [];
    const handled = await handleResumeCommand(
      "/resume",
      {
        addSystemMessage: (text: string) => messages.push(text),
        resetVisibleChat: () => resets.push("reset")
      } as unknown as ReturnType<typeof useChatController>,
      {
        listSessionSummaries: () => Promise.resolve([
          {
            id: "session-new",
            label: "New conversation",
            preview: null,
            sessionId: null,
            updatedAt: "2026-01-01T02:00:00.000Z"
          }
        ]),
        loadSession: () => Promise.resolve(null),
        openPicker: () => resets.push("reset"),
        restoreSession: () => false
      }
    );

    expect(handled).toBe(false);
    expect(resets).toEqual([]);
    expect(messages).toEqual(["Usage: /resume <ref>. Use /sessions to browse."]);
  });

  it("restores the selected saved session by prefix", async () => {
    const messages: string[] = [];
    const restored: string[] = [];
    const handled = await handleResumeCommand(
      "/resume session-ne",
      {
        addSystemMessage: (text: string) => messages.push(text)
      } as unknown as ReturnType<typeof useChatController>,
      {
        listSessionSummaries: () => Promise.resolve([
          {
            id: "session-new",
            label: "New conversation",
            preview: "Fix tests",
            sessionId: "session-a",
            updatedAt: "2026-01-01T02:00:00.000Z"
          }
        ]),
        loadSession: () => Promise.resolve({
          id: "session-new",
          messages: [{ id: "user:1", kind: "user", text: "Fix tests", timestamp: "2026-01-01T00:00:00.000Z" }],
          sessionId: "session-a",
          updatedAt: "2026-01-01T02:00:00.000Z"
        }),
        openPicker: () => {},
        restoreSession: (session) => {
          restored.push(session.id);
          return true;
        }
      }
    );

    expect(handled).toBe(true);
    expect(restored).toEqual(["session-new"]);
    expect(messages).toEqual([]);
  });

  it("restores the selected saved session by title with spaces", async () => {
    const messages: string[] = [];
    const restored: string[] = [];
    const resolved = vi.fn((ref: string) => ({
      ambiguous: [],
      sessionId: ref === "Project Alpha" ? "session-alpha-1234" : null
    }));
    const handled = await handleResumeCommand(
      "/resume Project Alpha",
      {
        addSystemMessage: (text: string) => messages.push(text)
      } as unknown as ReturnType<typeof useChatController>,
      {
        listSessionSummaries: () => Promise.resolve([]),
        loadSession: () => Promise.resolve({
          id: "session-alpha-1234",
          messages: [{ id: "user:1", kind: "user", text: "Fix tests", timestamp: "2026-01-01T00:00:00.000Z" }],
          sessionId: "session-alpha-1234",
          updatedAt: "2026-01-01T02:00:00.000Z"
        }),
        openPicker: () => {},
        resolveSessionRef: resolved,
        restoreSession: (session) => {
          restored.push(session.id);
          return true;
        }
      }
    );

    expect(handled).toBe(true);
    expect(resolved).toHaveBeenCalledWith("Project Alpha");
    expect(restored).toEqual(["session-alpha-1234"]);
    expect(messages).toEqual([]);
  });
});

describe("inbox slash command helper", () => {
  it("shows the selected pending inbox item by prefix", () => {
    process.env.USERNAME = "local-user";
    const messages: string[] = [];
    const item = createInboxRecord("inbox-12345678", {
      actionHint: "talon memory review-queue accept inbox-12345678",
      category: "memory_suggestion",
      summary: "A project memory suggestion is ready."
    });
    const handled = handleInboxCommand(
      "/inbox show inbox-12",
      { addSystemMessage: (text) => messages.push(text) },
      {
        listInbox: () => [item],
        showInboxItem: () => item
      }
    );

    expect(handled).toBe(true);
    expect(messages[0]).toContain("Inbox inbox-12345678 | Memory suggestion");
    expect(messages[0]).toContain("memory_suggestion | action_required | pending");
    expect(messages[0]).toContain("Next: talon memory review-queue accept inbox-12345678");
  });

  it("reports missing and ambiguous inbox prefixes", () => {
    process.env.USERNAME = "local-user";
    const messages: string[] = [];
    const items = [
      createInboxRecord("inbox-aaa11111"),
      createInboxRecord("inbox-aaa22222", { title: "Second inbox" })
    ];
    const service = {
      listInbox: () => items,
      showInboxItem: () => null
    };

    handleInboxCommand("/inbox show inbox-missing", { addSystemMessage: (text) => messages.push(text) }, service);
    handleInboxCommand("/inbox show inbox-aaa", { addSystemMessage: (text) => messages.push(text) }, service);

    expect(messages[0]).toContain("No pending inbox item matched prefix");
    expect(messages[1]).toContain("Ambiguous inbox prefix");
  });
});

function createOutputEvent(
  eventType: RuntimeOutputEvent["eventType"],
  payload: Record<string, unknown>
): RuntimeOutputEvent {
  return {
    eventId: `${eventType}-id`,
    eventType,
    payload,
    sequence: 1,
    stage: "completion",
    taskId: "task-001",
    sessionId: null,
    timestamp: "2026-01-01T00:00:00.000Z"
  } as RuntimeOutputEvent;
}

function createTraceEvent(
  eventType: TraceEvent["eventType"],
  payload: Record<string, unknown>
): TraceEvent {
  return {
    actor: "agent.runtime",
    eventId: `${eventType}-id`,
    eventType,
    payload,
    sequence: 1,
    stage: "tooling",
    summary: "summary",
    taskId: "task-001",
    timestamp: "2026-01-01T00:00:00.000Z"
  } as TraceEvent;
}

function createApprovalRecord(): ApprovalRecord {
  return {
    approvalId: "approval-1",
    decidedAt: null,
    errorCode: null,
    expiresAt: "2026-01-01T01:00:00.000Z",
    policyDecisionId: "policy-1",
    reason: "Need to write files",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "user-1",
    reviewerId: null,
    reviewerNotes: null,
    status: "pending",
    taskId: "task-001",
    toolCallId: "call-001",
    toolName: "write_file"
  };
}

function createInboxRecord(
  inboxId: string,
  overrides: Partial<Pick<InboxItem, "actionHint" | "category" | "summary" | "title">> = {}
): InboxItem {
  return {
    actionHint: overrides.actionHint ?? null,
    approvalId: null,
    bodyMd: null,
    category: overrides.category ?? "decision_requested",
    createdAt: "2026-01-01T00:00:00.000Z",
    dedupKey: null,
    doneAt: null,
    experienceId: null,
    inboxId,
    metadata: {},
    scheduleRunId: null,
    severity: "action_required",
    skillId: null,
    sourceTraceId: null,
    status: "pending",
    summary: overrides.summary ?? "Choose a next step.",
    taskId: null,
    sessionId: null,
    title: overrides.title ?? "Memory suggestion",
    updatedAt: "2026-01-01T01:00:00.000Z",
    userId: "local-user"
  };
}

function createToolCallRecord(): ToolCallRecord {
  return {
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    input: {},
    iteration: 1,
    output: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    riskLevel: "medium",
    startedAt: null,
    status: "awaiting_approval",
    summary: null,
    taskId: "task-001",
    toolCallId: "call-001",
    toolName: "write_file"
  };
}

function createApprovalLookupService() {
  return {
    showTask: () => ({
      approvals: [],
      artifacts: [],
      task: null,
      toolCalls: [createToolCallRecord()],
      trace: []
    })
  };
}

function createClarifyPromptRecord(): ClarifyPromptRecord {
  return {
    allowCustomAnswer: true,
    answerOptionId: null,
    answerText: null,
    answeredAt: null,
    errorCode: null,
    expiresAt: "2026-01-01T01:00:00.000Z",
    options: [
      {
        id: "option-1",
        label: "Option 1"
      }
    ],
    placeholder: "Type your answer",
    promptId: "prompt-1",
    question: "Need clarification?",
    reason: "Missing detail",
    requestedAt: "2026-01-01T00:00:00.000Z",
    requesterUserId: "user-1",
    reviewerId: null,
    status: "pending",
    taskId: "task-001",
    toolCallId: "call-clarify"
  };
}

function createScheduleRecord(scheduleId: string): ScheduleRecord {
  return {
    agentProfileId: "executor",
    backoffBaseMs: 5_000,
    backoffMaxMs: 300_000,
    createdAt: "2026-01-01T00:00:00.000Z",
    cron: null,
    cwd: process.cwd(),
    input: "scheduled prompt",
    intervalMs: 60_000,
    lastFireAt: null,
    maxAttempts: 3,
    metadata: {},
    name: scheduleId,
    nextFireAt: "2026-01-01T10:00:00.000Z",
    ownerUserId: "local-user",
    providerName: "mock",
    runAt: null,
    scheduleId,
    status: "active",
    sessionId: null,
    timezone: null,
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function createScheduleRunRecord(runId: string, scheduleId: string): ScheduleRunRecord {
  return {
    attemptNumber: 1,
    errorCode: null,
    errorMessage: null,
    finishedAt: null,
    metadata: {},
    runId,
    scheduleId,
    scheduledAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    status: "queued",
    taskId: "task-run",
    sessionId: null,
    trigger: "manual"
  };
}

function createControllerConfig(): AppConfig {
  return {
    allowedFetchHosts: [],
    approvalTtlMs: 60_000,
    budget: {
      pricing: {},
      task: {
        hardCostUsd: null,
        hardInputTokens: null,
        hardOutputTokens: null,
        softCostUsd: null,
        softInputTokens: null,
        softOutputTokens: null
      },
      session: {
        hardCostUsd: null,
        hardInputTokens: null,
        hardOutputTokens: null,
        softCostUsd: null,
        softInputTokens: null,
        softOutputTokens: null
      }
    },
    compact: {
      iterationThreshold: 20,
      messageThreshold: 20,
      summarizer: "deterministic",
      tokenThreshold: 8_000,
      toolCallThreshold: 10
    },
    databasePath: ":memory:",
    defaultMaxIterations: 4,
    defaultProfileId: "executor",
    defaultTimeoutMs: 10_000,
    promotion: {
      enabled: false,
      maxHumanJudgmentWeight: 0,
      minStability: 0,
      minSuccessCount: 0,
      minSuccessRate: 0,
      riskDenyKeywords: []
    },
    provider: {
      apiKey: null,
      baseUrl: null,
      builtinProviderName: "mock",
      configPath: "memory",
      configSource: "defaults",
      displayName: "Mock Provider",
      family: "mock",
      maxRetries: 0,
      model: "mock",
      name: "mock",
      timeoutMs: 10_000,
      transport: "mock"
    },
    recall: {
      budgetRatio: 0,
      enabled: false,
      maxCandidatesPerScope: 0
    },
    routing: {
      helpers: {
        classify: null,
        recallRank: null,
        summarize: null
      },
      mode: "balanced",
      providers: {}
    },
    runtimeConfigPath: "memory",
    runtimeConfigSource: "defaults",
    runtimeVersion: "test",
    sandbox: {
      configPath: null,
      configSource: "defaults",
      dockerImage: null,
      mode: "local",
      network: "disabled",
      profileName: null,
      readRoots: [process.cwd()],
      shellAllowlist: [],
      workspaceRoot: process.cwd(),
      writeRoots: [process.cwd()]
    },
    tokenBudget: {
      inputLimit: 8_000,
      outputLimit: 4_000,
      reservedOutput: 500,
      usedCostUsd: 0,
      usedInput: 0,
      usedOutput: 0
    },
    tui: {
      diffDisplay: "collapsed",
      statusLine: {
        command: null,
        padding: 0,
        showBranch: true,
        showCost: false,
        showMode: true,
        showModel: true,
        showTokens: true,
        style: "standard",
        timeoutMs: 2000,
        type: "builtin",
        updateIntervalMs: 300
      }
    },
    workflow: {
      failureGuidedRetry: {
        enabled: false,
        maxRepairAttempts: 0
      },
      repoMap: {
        enabled: false
      },
      testCommands: []
    },
    workspaceRoot: process.cwd()
  };
}

function createMultiTurnControllerService(config: {
  failAfterHiddenIntermediate?: boolean;
  hiddenIntermediate?: boolean;
} = {}): ControllerServiceStub {
  const tasks = new Map<string, TaskRecord>();
  let sequence = 0;

  const emit = (
    options: RuntimeRunOptions,
    draft: Omit<
      Extract<Parameters<NonNullable<RuntimeRunOptions["onOutputEvent"]>>[0], { eventType: string }>,
      "eventId" | "sequence" | "stage" | "taskId" | "sessionId" | "timestamp"
    > & { stage?: string }
  ): void => {
    sequence += 1;
    const event = {
      ...draft,
      eventId: `event-${sequence}`,
      sequence,
      stage: draft.stage ?? "planning",
      taskId: options.taskId ?? "task",
      sessionId: options.sessionId ?? null,
      timestamp: new Date().toISOString()
    };
    options.onOutputEvent?.(event as Parameters<NonNullable<RuntimeRunOptions["onOutputEvent"]>>[0]);
  };

  const runTask = (options: RuntimeRunOptions) => {
    const task = createControllerTask(options);
    tasks.set(task.taskId, task);

    emit(options, {
      eventType: "assistant_turn_started",
      payload: { display: "provisional", iteration: 1, providerName: "mock", turnId: "turn-1" }
    });
    options.onAssistantTextDelta?.("Let me check the README first.");
    emit(options, {
      eventType: "assistant_turn_delta",
      payload: { delta: "Let me check the README first.", display: "provisional", iteration: 1, turnId: "turn-1" }
    });
    emit(options, {
      eventType: "assistant_turn_completed",
      payload: {
        display: "intermediate",
        iteration: 1,
        text: "Let me check the README first.",
        ...(config.hiddenIntermediate ? { transcriptVisibility: "hidden" as const } : {}),
        turnId: "turn-1"
      },
      stage: "planning"
    });

    if (config.failAfterHiddenIntermediate === true) {
      task.status = "failed";
      task.errorCode = "sandbox_denied";
      task.errorMessage = "sandbox denied";
      task.finishedAt = new Date().toISOString();
      return Promise.resolve({
        error: new AppError({
          code: "sandbox_denied",
          message: "sandbox denied"
        }),
        output: null,
        task
      });
    }

    emit(options, {
      eventType: "assistant_turn_started",
      payload: { display: "provisional", iteration: 2, providerName: "mock", turnId: "turn-2" }
    });
    options.onAssistantTextDelta?.("Here is the answer.");
    emit(options, {
      eventType: "assistant_turn_delta",
      payload: { delta: "Here is the answer.", display: "provisional", iteration: 2, turnId: "turn-2" }
    });
    emit(options, {
      eventType: "assistant_turn_completed",
      payload: { display: "final", iteration: 2, text: "Here is the answer.", turnId: "turn-2" },
      stage: "completion"
    });

    task.status = "succeeded";
    task.finalOutput = "Here is the answer.";
    return Promise.resolve({ output: "Here is the answer.", task });
  };

  return {
    answerClarifyPrompt() {
      return Promise.reject(new Error("answerClarifyPrompt should not be called in this test."));
    },
    cancelClarifyPrompt() {
      throw new Error("cancelClarifyPrompt should not be called in this test.");
    },
    continueSession() {
      return Promise.reject(new Error("continueSession should not be called in this test."));
    },
    createSession() {
      throw new Error("createSession should not be called in this test.");
    },
    listPendingApprovals() {
      return [];
    },
    listPendingClarifyPrompts() {
      return [];
    },
    listTasks() {
      return [...tasks.values()];
    },
    providerStats() {
      return null;
    },
    resolveApproval() {
      throw new Error("resolveApproval should not be called in this test.");
    },
    runTask,
    showTask(taskId: string) {
      return {
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: tasks.get(taskId) ?? null,
        toolCalls: [],
        trace: []
      };
    },
    subscribeToTaskTrace() {
      return () => {};
    },
    traceTask() {
      return [];
    }
  };
}

function createStreamingControllerService(): ControllerServiceStub {
  const tasks = new Map<string, TaskRecord>();
  const runTask = async (options: RuntimeRunOptions) => {
    const task = createControllerTask(options);
    tasks.set(task.taskId, task);

    if (options.taskInput === "one") {
      await delay(5);
      options.onAssistantTextDelta?.("partial-one");
      await delay(20);
      task.status = "succeeded";
      task.finalOutput = "reply-one";
      return {
        output: "reply-one",
        task
      };
    }

    await delay(10);
    options.onAssistantTextDelta?.("partial-two");
    await delay(10);
    task.status = "succeeded";
    task.finalOutput = "reply-two";
    return {
      output: "reply-two",
      task
    };
  };

  return {
    answerClarifyPrompt() {
      return Promise.reject(new Error("answerClarifyPrompt should not be called in this test."));
    },
    cancelClarifyPrompt() {
      throw new Error("cancelClarifyPrompt should not be called in this test.");
    },
    continueSession(sessionId: string, text: string, overrides?: Partial<RuntimeRunOptions>) {
      const options = {
        ...createDefaultRunOptions(text, process.cwd(), createControllerConfig()),
        ...overrides,
        taskInput: text,
        sessionId
      };
      return runTask(options);
    },
    createSession() {
      return {
        agentProfileId: "executor",
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        cwd: process.cwd(),
        metadata: {},
        ownerUserId: "local-user",
        providerName: "mock",
        status: "active",
        sessionId: "session-created",
        title: "Untitled session",
        updatedAt: "2026-01-01T00:00:00.000Z"
      };
    },
    runTask,
    listPendingApprovals() {
      return [];
    },
    listPendingClarifyPrompts() {
      return [];
    },
    listTasks() {
      return [...tasks.values()];
    },
    providerStats() {
      return null;
    },
    resolveApproval() {
      throw new Error("resolveApproval should not be called in this test.");
    },
    showTask(taskId: string) {
      return {
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: tasks.get(taskId) ?? null,
        toolCalls: [],
        trace: []
      };
    },
    subscribeToTaskTrace() {
      return () => {};
    },
    traceTask() {
      return [];
    }
  };
}

function createIdleControllerService(): ControllerServiceStub {
  return {
    answerClarifyPrompt() {
      return Promise.reject(new Error("answerClarifyPrompt should not be called in this test."));
    },
    cancelClarifyPrompt() {
      throw new Error("cancelClarifyPrompt should not be called in this test.");
    },
    continueSession() {
      return Promise.reject(new Error("continueSession should not be called in this test."));
    },
    createSession() {
      throw new Error("createSession should not be called in this test.");
    },
    listPendingApprovals() {
      return [];
    },
    listPendingClarifyPrompts() {
      return [];
    },
    listTasks() {
      return [];
    },
    providerStats() {
      return null;
    },
    resolveApproval() {
      throw new Error("resolveApproval should not be called in this test.");
    },
    runTask() {
      return Promise.reject(new Error("runTask should not be called in this test."));
    },
    showTask() {
      return {
        approvals: [],
        artifacts: [],
        inboxItems: [],
        scheduleRuns: [],
        task: null,
        toolCalls: [],
        trace: []
      };
    },
    subscribeToTaskTrace() {
      return () => {};
    },
    traceTask() {
      return [];
    }
  };
}

function createControllerTask(options: RuntimeRunOptions): TaskRecord {
  const timestamp = new Date().toISOString();
  return {
    agentProfileId: options.agentProfileId,
    createdAt: timestamp,
    currentIteration: 0,
    cwd: options.cwd,
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: options.taskInput,
    maxIterations: options.maxIterations,
    metadata: options.metadata ?? {},
    providerName: "mock",
    requesterUserId: options.userId,
    startedAt: timestamp,
    status: "running",
    taskId: options.taskId ?? "task",
    sessionId: options.sessionId ?? null,
    tokenBudget: options.tokenBudget,
    updatedAt: timestamp
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for predicate.");
    }
    await delay(10);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

