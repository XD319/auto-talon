import type {
  AgentProfile,
  ConversationMessage,
  ContextAssemblyDebugView,
  ContextDebugFragment,
  ContextFragment,
  ProviderInput,
  ProviderToolDescriptor,
  TaskRecord,
  TokenBudget,
  ToolExposureDecision
} from "../types/index.js";
import { estimateMessagesTokens } from "./context/token-counter.js";

export interface ContextAssemblerInput {
  activeContextFragments?: ContextDebugFragment[];
  availableTools: ProviderToolDescriptor[];
  filteredOutFragments?: ContextAssemblyDebugView["filteredOutFragments"];
  iteration: number;
  memoryContext: ContextFragment[];
  messages: ConversationMessage[];
  signal: AbortSignal;
  task: TaskRecord;
  tokenBudget: TokenBudget;
}

export interface AssembledProviderContext {
  debug: ContextAssemblyDebugView;
  providerInput: ProviderInput;
}

export class ExecutionContextAssembler {
  public assemble(input: ContextAssemblerInput): AssembledProviderContext {
    const providerInput = {
      availableTools: input.availableTools,
      agentProfileId: input.task.agentProfileId,
      iteration: input.iteration,
      memoryContext: input.memoryContext,
      messages: input.messages,
      signal: input.signal,
      task: input.task,
      tokenBudget: input.tokenBudget
    };

    return {
      debug: buildContextDebugView(input),
      providerInput
    };
  }

  public buildInitialMessages(
    task: TaskRecord,
    availableTools: ProviderToolDescriptor[],
    profile: AgentProfile,
    repoMapSummary?: string,
    toolExposureDecisions: ToolExposureDecision[] = []
  ): ConversationMessage[] {
    const toolNames = availableTools.map((tool) => tool.name).join(", ");
    const publicWebFetchAvailable = availableTools.some(
      (tool) => tool.capability === "network.fetch_public_readonly"
    );
    const unavailableWebSearchNote = buildUnavailableWebSearchNote(toolExposureDecisions);
    const systemMessage = [
      profile.systemPrompt,
      "Use tools only when needed.",
      "Visible tools may still be denied by policy, sandbox checks, or approval requirements at execution time.",
      unavailableWebSearchNote,
      publicWebFetchAvailable
        ? "When web_extract is available, you may use it to read public web pages for current documentation or realtime public information. When web_search is available, you may use it to find public web pages before fetching them. These are sandboxed, read-only network tools and must not be used for private, internal, or authenticated resources."
        : null,
      `Available tools: ${toolNames}.`
    ]
      .filter((part): part is string => part !== null)
      .join(" ");

    const messages: ConversationMessage[] = [
      {
        content: systemMessage,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "working",
          sourceType: "system_prompt"
        },
        role: "system"
      },
    ];
    if (repoMapSummary !== undefined) {
      messages.push({
        content: repoMapSummary,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "working",
          sourceType: "system_prompt"
        },
        role: "system"
      });
    }
    messages.push(
      {
        content: task.input,
        metadata: {
          privacyLevel: "internal",
          retentionKind: "working",
          sourceType: "user_input"
        },
        role: "user"
      }
    );
    return messages;
  }
}

function buildUnavailableWebSearchNote(
  decisions: ToolExposureDecision[]
): string | null {
  const webSearchDecision = decisions.find(
    (decision) => decision.toolName === "web_search" && !decision.exposed
  );
  if (webSearchDecision === undefined) {
    return null;
  }
  const reason = normalizeUnavailableToolReason(webSearchDecision.reason);
  const setupHint = buildWebSearchSetupHint();
  return [
    `web_search is unavailable: ${reason}.`,
    "Do not answer from general knowledge or training data as a substitute for live search results.",
    "Explain the limitation clearly, then offer the setup steps below.",
    `Setup: ${setupHint}`,
    "web_extract can read only known public URLs and cannot discover search results."
  ].join(" ");
}

function buildWebSearchSetupHint(): string {
  return [
    "Set web.searchBackend to \"auto\" (default) or a specific provider in runtime config,",
    "or set provider credentials in the environment (FIRECRAWL_API_KEY, TAVILY_API_KEY, EXA_API_KEY, BRAVE_SEARCH_API_KEY, SEARXNG_URL, DDGS_URL).",
    "Built-in search uses DuckDuckGo with Bing HTML fallback when DuckDuckGo is blocked."
  ].join(" ");
}

function normalizeUnavailableToolReason(reason: string): string {
  return reason.replace(/^unavailable:\s*/iu, "").trim();
}

function buildContextDebugView(input: ContextAssemblerInput): ContextAssemblyDebugView {
  const originalTaskInput = input.messages.find((message) => message.role === "user") ?? {
    content: input.task.input,
    role: "user" as const
  };

  return {
    activeContextFragments: input.activeContextFragments ?? [],
    filteredOutFragments: input.filteredOutFragments ?? [],
    iteration: input.iteration,
    memoryRecallFragments: input.memoryContext.map((fragment) =>
      toMemoryDebugFragment(fragment)
    ),
    originalTaskInput: {
      label: "User task input",
      metadata: {
        role: "user"
      },
      preview: sanitizePreview(originalTaskInput.content, "internal"),
      privacyLevel: "internal",
      retentionPolicy: {
        kind: "working",
        reason: "Task input remains part of the active session context.",
        ttlDays: null
      },
      sourceType: "user_input"
    },
    tokenBudget: {
      estimatedInputTokens: estimateInputTokens(input.messages, input.memoryContext),
      inputLimit: input.tokenBudget.inputLimit,
      outputLimit: input.tokenBudget.outputLimit,
      reservedOutput: input.tokenBudget.reservedOutput,
      usedInput: input.tokenBudget.usedInput,
      usedOutput: input.tokenBudget.usedOutput
    },
    systemPromptFragments: input.messages
      .filter((message) => message.role === "system")
      .map((message, index) =>
        toMessageDebugFragment(message, "system_prompt", `System prompt ${index + 1}`)
      ),
    taskId: input.task.taskId,
    toolResultFragments: input.messages
      .filter((message) => message.role === "tool")
      .map((message, index) =>
        toMessageDebugFragment(
          message,
          "tool_result",
          message.toolName === undefined ? `Tool result ${index + 1}` : `Tool result ${message.toolName}`
        )
      )
  };
}

function estimateInputTokens(messages: ConversationMessage[], memoryContext: ContextFragment[]): number {
  return estimateMessagesTokens([
    ...messages,
    ...memoryContext.map((fragment) => ({ content: fragment.text }))
  ]);
}

export function buildFilteredContextDebugFragments(
  decisions: Array<{
    allowed: boolean;
    fragment: ContextFragment;
    reason: string;
    reasonCode: "allowed" | "filtered_by_policy" | "filtered_by_privacy" | "filtered_by_retention" | "filtered_by_scope";
  }>
): ContextAssemblyDebugView["filteredOutFragments"] {
  return decisions
    .filter((decision) => !decision.allowed)
    .map((decision) => ({
      ...toMemoryDebugFragment(decision.fragment, "filtered_out"),
      filterReason: decision.reason,
      filterReasonCode: decision.reasonCode
    }));
}

function toMemoryDebugFragment(
  fragment: ContextFragment,
  sourceType: "memory_recall" | "filtered_out" = "memory_recall"
): ContextDebugFragment {
  return {
    label: fragment.title,
    metadata: {
      confidence: Number(fragment.confidence.toFixed(2)),
      memoryId: fragment.memoryId,
      scope: fragment.scope,
      status: fragment.status
    },
    preview: sanitizePreview(fragment.text, fragment.privacyLevel),
    privacyLevel: fragment.privacyLevel,
    retentionPolicy: fragment.retentionPolicy,
    sourceType
  };
}

function toMessageDebugFragment(
  message: ConversationMessage,
  sourceType: "system_prompt" | "tool_result",
  label: string
): ContextDebugFragment {
  const privacyLevel = readPrivacyLevel(message);
  const retentionKind = readRetentionKind(message);

  return {
    label,
    metadata: {
      role: message.role,
      toolCallId: message.toolCallId ?? null,
      toolName: message.toolName ?? null
    },
    preview: sanitizePreview(message.content, privacyLevel),
    privacyLevel,
    retentionPolicy: {
      kind: retentionKind,
      reason:
        sourceType === "system_prompt"
          ? "System prompts are retained with the active session."
          : "Tool result injections are retained with the active session.",
      ttlDays: null
    },
    sourceType
  };
}

function sanitizePreview(value: string, privacyLevel: "public" | "internal" | "restricted"): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (privacyLevel === "restricted") {
    return "[REDACTED: restricted content]";
  }

  const masked = compact
    .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/giu, "[REDACTED_EMAIL]")
    .replace(/\b(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/giu, "[REDACTED_SECRET]");

  return masked.length <= 220 ? masked : `${masked.slice(0, 220)}...`;
}

function readPrivacyLevel(message: ConversationMessage): "public" | "internal" | "restricted" {
  const value = message.metadata?.privacyLevel;
  return value === "public" || value === "restricted" ? value : "internal";
}

function readRetentionKind(
  message: ConversationMessage
): "profile" | "ephemeral" | "project" | "working" {
  const value = message.metadata?.retentionKind;
  return value === "profile" || value === "ephemeral" || value === "project" ? value : "working";
}
