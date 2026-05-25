import { AppError } from "../core/app-error.js";
import { ProviderError, toProviderError } from "../providers/index.js";
import type {
  ContextAssemblyDebugView,
  ContextFragment,
  ConversationMessage,
  Provider,
  RuntimeRunOptions,
  RuntimeTaskEvent,
  SessionCompactInput,
  TaskRecord,
  ToolCapability
} from "../types/index.js";

export const DEDUPLICATABLE_CAPABILITIES = new Set<ToolCapability>([
  "filesystem.read",
  "network.fetch_public_readonly"
]);

export function providerUsageToJson(usage: {
  cachedInputTokens?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}): Record<string, number> {
  const payload: Record<string, number> = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens
  };

  if (usage.totalTokens !== undefined) {
    payload.totalTokens = usage.totalTokens;
  }

  if (usage.cachedInputTokens !== undefined) {
    payload.cachedInputTokens = usage.cachedInputTokens;
  }

  return payload;
}

export function createToolFeedbackMessage(
  output: unknown,
  toolCall: { toolCallId: string; toolName: string },
  privacyLevel: "public" | "internal" | "restricted"
): ConversationMessage {
  const serializedOutput = safeSerializeToolOutput(output);
  return {
    content: serializedOutput ?? "null",
    metadata: {
      privacyLevel,
      retentionKind: "session",
      sourceType: "tool_result"
    },
    role: "tool",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName
  };
}

export function createToolFeedbackMessageWithNotice(
  output: unknown,
  toolCall: { toolCallId: string; toolName: string },
  privacyLevel: "public" | "internal" | "restricted",
  notice: string
): ConversationMessage {
  const base = createToolFeedbackMessage(output, toolCall, privacyLevel);
  return {
    ...base,
    content: `${notice}\n\n${base.content}`
  };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export function toolCallSignature(toolName: string, input: unknown): string {
  try {
    return `${toolName}|${stableStringify(input ?? null)}`;
  } catch {
    return `${toolName}|${JSON.stringify(input ?? null)}`;
  }
}

export function rebuildSignaturesFromMessages(
  messages: ConversationMessage[],
  isDeduplicatable: (toolName: string) => boolean
): Map<string, { iteration: number; toolCallId: string }> {
  const signatures = new Map<string, { iteration: number; toolCallId: string }>();
  let iteration = 0;
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      iteration += 1;
      for (const call of message.toolCalls) {
        if (!isDeduplicatable(call.toolName)) {
          continue;
        }
        const signature = toolCallSignature(call.toolName, call.input);
        if (!signatures.has(signature)) {
          signatures.set(signature, { iteration, toolCallId: call.toolCallId });
        }
      }
    }
  }
  return signatures;
}

/**
 * Returns true when the persisted message history contains at least one tool-result
 * message whose tool is classified as a filesystem write and whose payload does not
 * look like the error envelope produced by `toolResultOutputForModel` on failure.
 *
 * Used when resuming a task from an approval/clarification checkpoint so the runtime
 * does not pessimistically treat the new turn as if no write has ever happened —
 * otherwise `evaluateNoWriteFinal` defers a perfectly valid final response and the
 * next iteration is forced to retry, eventually tripping the `task_incomplete` guard.
 */
export function historyHasSuccessfulWrite(
  messages: ConversationMessage[],
  isWriteTool: (toolName: string) => boolean
): boolean {
  for (const message of messages) {
    if (message.role !== "tool" || message.toolName === undefined) {
      continue;
    }
    if (!isWriteTool(message.toolName)) {
      continue;
    }
    if (!isToolResultErrorEnvelope(message.content)) {
      return true;
    }
  }
  return false;
}

function isToolResultErrorEnvelope(content: string): boolean {
  if (content.length === 0 || content === "null") {
    // Empty/null payload cannot prove success, but write tools always serialize a
    // non-empty object on success in our codebase, so treat this as inconclusive
    // (the caller will keep scanning later messages).
    return true;
  }
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("{")) {
    return false;
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const record = parsed as Record<string, unknown>;
    return typeof record.errorCode === "string" && typeof record.error === "string";
  } catch {
    return false;
  }
}

export function buildReviewerTracePayload(
  iteration: number,
  debug: ContextAssemblyDebugView,
  providerResponse: { kind: "final" | "retry" | "tool_calls"; message: string }
): {
  blockingReason: string | null;
  continuationBlocked: boolean;
  iteration: number;
  reviewerJudgementSummary: string;
  reviewerSeenSummary: string;
  riskDetected: boolean;
} {
  const reviewerSeenSummary = summarizeText(
    [
      debug.originalTaskInput.preview,
      ...debug.activeContextFragments.map((fragment) => fragment.preview),
      ...debug.systemPromptFragments.map((fragment) => fragment.preview),
      ...debug.memoryRecallFragments.map((fragment) => fragment.preview),
      ...debug.toolResultFragments.map((fragment) => fragment.preview)
    ]
      .filter(Boolean)
      .join(" | "),
    260
  );
  const reviewerJudgementSummary = summarizeText(providerResponse.message, 220);
  const lowered = providerResponse.message.toLowerCase();
  const riskDetected =
    lowered.includes("risk") ||
    lowered.includes("block") ||
    lowered.includes("unsafe") ||
    lowered.includes("deny") ||
    lowered.includes("stop");
  const continuationBlocked = providerResponse.kind === "final" && riskDetected;

  return {
    blockingReason: continuationBlocked ? reviewerJudgementSummary : null,
    continuationBlocked,
    iteration,
    reviewerJudgementSummary,
    reviewerSeenSummary,
    riskDetected
  };
}

export function normalizeProviderFailure(
  error: unknown,
  provider: Provider
): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  return toProviderError(error, provider.name, provider.model ?? provider.describe?.().model ?? undefined);
}

export async function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(
        new AppError({
          code: "interrupt",
          message: "Retry wait interrupted."
        })
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function summarizeText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength)}...`;
}

export function emitTaskEvent(
  callback: ((event: RuntimeTaskEvent) => void) | undefined,
  event: RuntimeTaskEvent
): void {
  if (callback === undefined) {
    return;
  }
  callback(event);
}

export function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return summarizeText(output, 140);
  }
  if (output === null || output === undefined) {
    return "output=null";
  }
  if (Array.isArray(output)) {
    return `output=array(${output.length})`;
  }
  if (typeof output === "object") {
    const keys = Object.keys(output as Record<string, unknown>);
    return `output=object{${keys.slice(0, 6).join(",")}${keys.length > 6 ? ",..." : ""}}`;
  }
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return `output=${output.toString()}`;
  }
  if (typeof output === "symbol") {
    return `output=${output.description ?? "symbol"}`;
  }
  return "output=[unsupported]";
}

export function buildFinalSessionCompactInput(
  messages: ConversationMessage[],
  task: TaskRecord
): SessionCompactInput & { reason: "context_budget" } {
  return {
    maxMessagesBeforeCompact: messages.length,
    messages: messages.map((message) => ({
      content:
        message.role === "assistant" && message.toolCalls !== undefined
          ? ""
          : message.content,
      role: message.role,
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((toolCall) => ({
              toolCallId: toolCall.toolCallId,
              toolName: toolCall.toolName
            }))
          }
        : {})
    })),
    originalGoal: task.input,
    reason: "context_budget",
    sessionScopeKey: task.threadId ?? task.taskId,
    taskId: task.taskId
  };
}

export function readThreadResumeMessages(metadata: RuntimeRunOptions["metadata"]): ConversationMessage[] {
  if (metadata === undefined || metadata === null) {
    return [];
  }
  const threadResume = (metadata as Record<string, unknown>).threadResume;
  if (typeof threadResume !== "object" || threadResume === null) {
    return [];
  }
  const contextMessages = (threadResume as Record<string, unknown>).contextMessages;
  if (!Array.isArray(contextMessages)) {
    return [];
  }
  return contextMessages.filter(
    (message): message is ConversationMessage =>
      typeof message === "object" &&
      message !== null &&
      typeof (message as { role?: unknown }).role === "string" &&
      typeof (message as { content?: unknown }).content === "string"
  );
}

export function readThreadResumeMemoryContext(metadata: RuntimeRunOptions["metadata"]): ContextFragment[] {
  if (metadata === undefined || metadata === null) {
    return [];
  }
  const threadResume = (metadata as Record<string, unknown>).threadResume;
  if (typeof threadResume !== "object" || threadResume === null) {
    return [];
  }
  const memoryContext = (threadResume as Record<string, unknown>).memoryContext;
  if (!Array.isArray(memoryContext)) {
    return [];
  }
  return memoryContext.filter(
    (fragment): fragment is ContextFragment =>
      typeof fragment === "object" &&
      fragment !== null &&
      typeof (fragment as { memoryId?: unknown }).memoryId === "string" &&
      typeof (fragment as { text?: unknown }).text === "string"
  );
}

export function injectResumeContextMessages(
  messages: ConversationMessage[],
  resumeMessages: ConversationMessage[]
): void {
  if (resumeMessages.length === 0) {
    return;
  }
  const firstSystemIndex = messages.findIndex((message) => message.role === "system");
  const insertAt = firstSystemIndex >= 0 ? firstSystemIndex + 1 : 0;
  messages.splice(insertAt, 0, ...resumeMessages);
}

export function rebuildTurnProviderMessages(
  messages: ConversationMessage[],
  previousProviderMessages: ConversationMessage[]
): ConversationMessage[] {
  void previousProviderMessages;
  return messages;
}

export function estimateTokenCount(messages: ConversationMessage[]): number {
  const joined = messages.map((message) => message.content).join("\n");
  return Math.ceil(joined.length / 4);
}

export function toConversationRole(role: string): "assistant" | "system" | "tool" | "user" {
  return role === "assistant" || role === "system" || role === "tool" || role === "user"
    ? role
    : "system";
}

function safeSerializeToolOutput(output: unknown): string {
  try {
    return JSON.stringify(output, createSafeJsonReplacer(), 2) ?? "null";
  } catch {
    return "[unserializable tool output]";
  }
}

function createSafeJsonReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "function") {
      return `[function:${value.name || "anonymous"}]`;
    }
    if (typeof value === "symbol") {
      return `[symbol:${value.description ?? "symbol"}]`;
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[circular]";
      }
      seen.add(value);
    }
    return value;
  };
}
