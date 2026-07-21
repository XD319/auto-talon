import type { ConversationMessage } from "../types/index.js";

export function conversationHadToolCallsBefore(
  messages: ConversationMessage[],
  messageIndex: number
): boolean {
  for (let index = 0; index < messageIndex; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      return true;
    }
  }
  return false;
}

export function shouldReplayReasoningContent(
  message: ConversationMessage,
  messages: ConversationMessage[],
  messageIndex: number
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  if ((message.toolCalls?.length ?? 0) > 0) {
    return true;
  }
  if (message.reasoningContent === undefined) {
    return false;
  }
  return conversationHadToolCallsBefore(messages, messageIndex);
}

export function reasoningContentForReplay(
  message: ConversationMessage,
  messages: ConversationMessage[],
  messageIndex: number
): string | undefined {
  if (!shouldReplayReasoningContent(message, messages, messageIndex)) {
    return undefined;
  }
  return message.reasoningContent ?? "";
}

export function parseReasoningContent(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function resolveProviderFinalText(response: {
  kind: string;
  message: string;
  reasoningContent?: string;
}): string | null {
  if (response.kind !== "final") {
    return null;
  }
  const message = response.message.trim();
  if (message.length > 0) {
    return message;
  }
  const reasoning = response.reasoningContent?.trim() ?? "";
  return reasoning.length > 0 ? reasoning : null;
}

export const FINAL_OUTPUT_POLISH_MAX_LENGTH = 4_000;

export function isReasoningOnlyFinal(response: {
  kind: string;
  message: string;
  reasoningContent?: string;
}): boolean {
  if (response.kind !== "final") {
    return false;
  }
  return response.message.trim().length === 0 && (response.reasoningContent?.trim().length ?? 0) > 0;
}

export function looksLikeInternalReasoning(text: string): boolean {
  const sample = text.slice(0, 12_000).toLowerCase();
  const markers = [
    "let me think",
    "let me re-read",
    "let me look",
    "let me now identify",
    "bug candidate",
    "candidate #",
    "wait,",
    "actually wait",
    "hmm,",
    "i need to",
    "思考一下",
    "让我再",
    "让我仔细",
    "候选",
    "再想想"
  ];
  let hits = 0;
  for (const marker of markers) {
    if (sample.includes(marker)) {
      hits += 1;
    }
  }
  return hits >= 2 || /bug candidate\s*#/u.test(sample);
}

export function shouldPolishFinalOutput(
  response: {
    kind: string;
    message: string;
    reasoningContent?: string;
  },
  resolvedText: string
): { polish: boolean; trigger: "reasoning_only_final" | "final_output_too_long" | "internal_reasoning_detected" | null } {
  if (response.kind !== "final") {
    return { polish: false, trigger: null };
  }
  if (isReasoningOnlyFinal(response)) {
    return { polish: true, trigger: "reasoning_only_final" };
  }
  if (resolvedText.length > FINAL_OUTPUT_POLISH_MAX_LENGTH) {
    return { polish: true, trigger: "final_output_too_long" };
  }
  if (looksLikeInternalReasoning(resolvedText)) {
    return { polish: true, trigger: "internal_reasoning_detected" };
  }
  return { polish: false, trigger: null };
}

export function looksLikeToolMarkup(text: string): boolean {
  const sample = text.trim();
  if (sample.length === 0) {
    return false;
  }
  return (
    /<\|[^|>]*\|>/u.test(sample) ||
    /<\uFF5C\uFF5C[^>]*\uFF5C\uFF5C>/u.test(sample) ||
    sample.includes("tool_calls>") ||
    sample.includes("<invoke") ||
    /\binvoke\s+name=/u.test(sample) ||
    /<tool_call>/iu.test(sample) ||
    /<\/tool_call>/iu.test(sample) ||
    /<arg_key>/iu.test(sample) ||
    /<arg_value>/iu.test(sample) ||
    (sample.includes('"toolName"') && sample.includes("toolCallId"))
  );
}

export function isAcceptableUserFinalText(
  response: {
    kind: string;
    message: string;
    reasoningContent?: string;
  },
  resolvedText: string
): { acceptable: boolean; reason: "empty" | "too_short" | "tool_markup" | "reasoning_only_final" | "final_output_too_long" | "internal_reasoning_detected" | null } {
  const text = resolvedText.trim();
  if (text.length === 0) {
    return { acceptable: false, reason: "empty" };
  }
  if (looksLikeToolMarkup(text)) {
    return { acceptable: false, reason: "tool_markup" };
  }
  const polishDecision = shouldPolishFinalOutput(response, text);
  if (polishDecision.polish) {
    return {
      acceptable: false,
      reason: polishDecision.trigger
    };
  }
  return { acceptable: true, reason: null };
}
