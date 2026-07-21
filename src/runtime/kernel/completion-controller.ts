import type {
  ConversationMessage,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDescriptor,
  TaskRecord,
  ToolExecutionResult,
  TraceEventDraft,
  TuiInteractionMode
} from "../../types/index.js";

export const PROGRESS_GUARD_THRESHOLD = 3;
export const READ_ONLY_GUARD_THRESHOLD = 8;
export const POST_COMPLETION_VERIFICATION_READ_LIMIT = 1;

export interface CompletionControllerState {
  completionIntentSeenAt: number | null;
  completionVerificationGuardEmitted: boolean;
  completionVerificationSatisfied: boolean;
  completionVerificationSatisfiedEmitted: boolean;
  criticalBudgetPressureEmitted: boolean;
  maxIterations: number;
  messages: ConversationMessage[];
  postCompletionVerificationReads: number;
  readOnlyTurns: number;
  silentToolTurns: number;
  turnProviderMessages: ConversationMessage[];
  warningBudgetPressureEmitted: boolean;
  writeToolSucceeded: boolean;
}

export interface CompletionControllerDependencies {
  describeTool(toolName: string): ProviderToolDescriptor | null;
  recordTrace(event: TraceEventDraft): void;
  testCommands?: string[];
}

export class CompletionController {
  public constructor(private readonly dependencies: CompletionControllerDependencies) {}

  public maybeInjectIterationBudgetPressure(
    state: CompletionControllerState,
    taskId: string,
    iteration: number
  ): void {
    const ratio = iteration / Math.max(1, state.maxIterations);
    const tier = ratio >= 0.9 ? "critical" : ratio >= 0.7 ? "warning" : null;
    if (tier === null) {
      return;
    }
    if (tier === "warning" && state.warningBudgetPressureEmitted) {
      return;
    }
    if (tier === "critical" && state.criticalBudgetPressureEmitted) {
      return;
    }
    if (tier === "warning") {
      state.warningBudgetPressureEmitted = true;
    } else {
      state.criticalBudgetPressureEmitted = true;
    }
    const remainingIterations = Math.max(0, state.maxIterations - iteration + 1);
    const pressureMessage: ConversationMessage = {
      content:
        tier === "critical"
          ? `Iteration budget critical: ${remainingIterations}/${state.maxIterations} loop iterations remain. Stop nonessential tool calls now and provide the final answer as soon as possible.`
          : `Iteration budget warning: ${remainingIterations}/${state.maxIterations} loop iterations remain. Begin converging; use tools only if they are required to finish the user's request.`,
      metadata: {
        privacyLevel: "internal",
        retentionKind: "session",
        sourceType: "system_prompt"
      },
      role: "system"
    };
    state.messages.push(pressureMessage);
    if (state.turnProviderMessages !== state.messages) {
      state.turnProviderMessages.push(pressureMessage);
    }
    this.dependencies.recordTrace({
      actor: "runtime.loop",
      eventType: "iteration_budget_pressure",
      payload: {
        iteration,
        maxIterations: state.maxIterations,
        remainingIterations,
        tier
      },
      stage: "control",
      summary: `Iteration budget pressure: ${tier}`,
      taskId
    });
  }

  public observeProviderToolTurn(
    state: CompletionControllerState,
    messages: ConversationMessage[],
    task: TaskRecord,
    iteration: number,
    providerResponse: Extract<ProviderResponse, { kind: "tool_calls" }>,
    interactionMode: TuiInteractionMode = "agent"
  ): void {
    const visibleReasoningText = providerResponse.message.trim();
    if (visibleReasoningText.length === 0) {
      state.silentToolTurns += 1;
    } else {
      state.silentToolTurns = 0;
    }
    if (state.silentToolTurns >= PROGRESS_GUARD_THRESHOLD) {
      messages.push({
        content:
          `progress guard: you have made ${state.silentToolTurns} consecutive tool-call rounds at iterations ${iteration - state.silentToolTurns + 1}-${iteration} without writing any visible reasoning text. Stop calling tools and answer the user's request based on what you already know. If the original question was conceptual or general-knowledge, answer directly without further tool use.`,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      });
      state.silentToolTurns = 0;
    }

    if (this.allToolCallsAreReads(providerResponse.toolCalls)) {
      state.readOnlyTurns += 1;
    } else {
      state.readOnlyTurns = 0;
    }
    if (state.readOnlyTurns >= READ_ONLY_GUARD_THRESHOLD) {
      messages.push({
        content: buildReadOnlyAnalysisGuardMessage(interactionMode),
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      });
      this.dependencies.recordTrace({
        actor: "runtime.kernel",
        eventType: "read_only_analysis_guard",
        payload: {
          iteration,
          readOnlyTurns: state.readOnlyTurns
        },
        stage: "control",
        summary: "Read-only analysis guard triggered",
        taskId: task.taskId
      });
      state.readOnlyTurns = 0;
    }
  }

  public evaluatePostCompletionToolCalls(
    state: CompletionControllerState,
    iteration: number,
    providerResponse: Extract<ProviderResponse, { kind: "tool_calls" }>
  ): "continue" | "summarize" {
    if (!state.writeToolSucceeded || !this.allToolCallsAreReads(providerResponse.toolCalls)) {
      return "continue";
    }

    if (state.completionIntentSeenAt === null && hasCompletionIntent(providerResponse.message)) {
      state.completionIntentSeenAt = iteration;
    }
    if (state.completionIntentSeenAt === null) {
      return "continue";
    }

    if (state.postCompletionVerificationReads >= POST_COMPLETION_VERIFICATION_READ_LIMIT) {
      return "summarize";
    }
    state.postCompletionVerificationReads += 1;
    return "continue";
  }

  public evaluateFinalVerification(
    state: CompletionControllerState,
    messages: ConversationMessage[],
    task: TaskRecord,
    iteration: number,
    finalOutput: string,
    options: { allowGuard?: boolean } = {}
  ): { finalOutput: string; kind: "complete" } | { kind: "guard" } {
    const allowGuard = options.allowGuard !== false;
    if (!state.writeToolSucceeded || state.completionVerificationSatisfied) {
      return {
        finalOutput,
        kind: "complete"
      };
    }

    if (mentionsUnverifiedWork(finalOutput)) {
      this.recordCompletionVerificationMissing(task, iteration, "model_reported_unverified");
      return {
        finalOutput,
        kind: "complete"
      };
    }

    if (allowGuard && !state.completionVerificationGuardEmitted) {
      const testCommands = this.dependencies.testCommands ?? [];
      const cmdHint =
        testCommands.length > 0 ? ` Suggested commands: ${testCommands.join(", ")}.` : "";
      messages.push({
        content:
          "Completion verification required: workspace files were changed after the last successful verification. Before finalizing, run an appropriate configured test/build/lint/typecheck command, or clearly state the unverified items and why verification could not be run." +
          cmdHint,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "session",
          sourceType: "system_prompt"
        },
        role: "system"
      });
      state.turnProviderMessages = messages;
      state.completionVerificationGuardEmitted = true;
      this.recordCompletionVerificationMissing(task, iteration, "guard_prompted");
      return { kind: "guard" };
    }

    this.recordCompletionVerificationMissing(task, iteration, "runtime_appended_warning");
    return {
      finalOutput: `${finalOutput}\n\nUnverified: workspace changes were made after the last successful verification, and no verification command was recorded.`,
      kind: "complete"
    };
  }

  public allToolCallsAreReads(toolCalls: ProviderToolCall[]): boolean {
    return toolCalls.length > 0 && toolCalls.every((call) => this.isReadOnlyToolCall(call.toolName));
  }

  public isReadOnlyToolCall(toolName: string): boolean {
    const descriptor = this.dependencies.describeTool(toolName);
    if (descriptor !== null) {
      return (
        descriptor.capability === "filesystem.read" ||
        descriptor.capability === "network.fetch_public_readonly"
      );
    }
    return isReadOnlyToolName(toolName);
  }

  private recordCompletionVerificationMissing(
    task: TaskRecord,
    iteration: number,
    reason: "guard_prompted" | "model_reported_unverified" | "runtime_appended_warning"
  ): void {
    this.dependencies.recordTrace({
      actor: "runtime.kernel",
      eventType: "completion_verification_missing",
      payload: {
        iteration,
        reason
      },
      stage: "completion",
      summary: "Completion verification is missing after workspace changes",
      taskId: task.taskId
    });
  }
}

export function isSuccessfulVerificationToolCall(
  toolName: string,
  result: ToolExecutionResult,
  configuredTestCommands: string[] = []
): boolean {
  if (!result.success) {
    return false;
  }
  if (toolName !== "shell" && toolName !== "process") {
    return false;
  }
  const output = result.runtimeOutput ?? result.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return false;
  }
  const exitCode = (output as { exitCode?: unknown }).exitCode;
  const command = (output as { command?: unknown }).command;
  return (
    exitCode === 0 &&
    typeof command === "string" &&
    isVerificationCommand(command, configuredTestCommands)
  );
}

export function mentionsUnverifiedWork(message: string): boolean {
  const compact = message.toLowerCase();
  return (
    compact.includes("unverified") ||
    compact.includes("not verified") ||
    compact.includes("could not verify") ||
    compact.includes("couldn't verify") ||
    compact.includes("unable to verify")
  );
}

export function buildReadOnlyAnalysisGuardMessage(interactionMode: TuiInteractionMode = "agent"): string {
  if (interactionMode === "plan") {
    return (
      "synthesis guard: you have spent many consecutive turns reading files without producing a user-facing answer. " +
      "Stop reading and synthesize your findings into a concrete analysis or plan now. " +
      "Do not call write, patch, shell, or todo tools in plan mode. " +
      "Answer the user's request directly in a concise numbered list without chain-of-thought."
    );
  }
  return (
    "synthesis guard: you have spent many consecutive turns reading files without producing a user-facing answer. " +
    "Stop reading and synthesize your findings into a concrete response now. " +
    "Answer the user's request directly in a concise numbered list without chain-of-thought."
  );
}

export function hasCompletionIntent(message: string): boolean {
  const compact = message.replace(/\s+/gu, " ").trim().toLowerCase();
  if (compact.length === 0) {
    return false;
  }
  const planningSignals = [
    "让我",
    "我需要",
    "需要我继续",
    "let me",
    "need to",
    "what's missing",
    "this tool call"
  ];
  if (planningSignals.some((signal) => compact.includes(signal))) {
    return false;
  }
  const completionSignals = [
    /已完成/u,
    /第一阶段[^。？！?]{0,30}完成/u,
    /基础框架搭建[^。？！?]{0,30}完成/u,
    /完成情况/u,
    /all files are complete/u,
    /complete and functional/u,
    /completed the .*task/u,
    /implementation is complete/u,
    /work is complete/u
  ];
  return completionSignals.some((pattern) => pattern.test(compact));
}

function isReadOnlyToolName(toolName: string): boolean {
  return (
    toolName.includes("read") ||
    toolName.includes("search") ||
    toolName.includes("fetch") ||
    toolName.includes("view")
  );
}

export function isVerificationCommand(
  command: string,
  configuredTestCommands: string[] = []
): boolean {
  const compact = command.toLowerCase().trim();
  if (compact.length === 0) {
    return false;
  }
  if (
    compact.includes("test") ||
    compact.includes("build") ||
    compact.includes("lint") ||
    compact.includes("typecheck") ||
    compact.includes("tsc")
  ) {
    return true;
  }
  // Accept one-off node verification scripts (node verify.mjs, node --test, node ./check.js).
  if (/\bnode(?:\.exe)?\b/u.test(compact) && !/\s-(?:e|p)\b/u.test(compact) && !/\s--(?:eval|print)\b/u.test(compact)) {
    if (/\b--test\b/u.test(compact) || /\.(?:m?js|cjs|ts)\b/u.test(compact)) {
      return true;
    }
  }
  return configuredTestCommands.some((configured) => {
    const hint = configured.toLowerCase().trim();
    return hint.length > 0 && (compact === hint || compact.includes(hint) || hint.includes(compact));
  });
}
