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
