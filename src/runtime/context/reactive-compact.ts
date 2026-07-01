import type { ConversationMessage } from "../../types/index.js";
import type { ProviderError } from "../../providers/provider-error.js";
import { SESSION_TODOS_SOURCE_TYPE } from "./session-todos.js";

export const COMPACT_HANDOFF_SOURCE_TYPE = "compact_handoff";

export function isContextOverflowProviderError(error: ProviderError): boolean {
  if (error.statusCode === 413) {
    return true;
  }

  const haystack = `${error.message} ${error.summary ?? ""}`.toLowerCase();
  return (
    haystack.includes("context length") ||
    haystack.includes("context window") ||
    haystack.includes("maximum context") ||
    haystack.includes("prompt is too long") ||
    haystack.includes("prompt too long") ||
    haystack.includes("token limit") ||
    haystack.includes("too many tokens") ||
    haystack.includes("context_length_exceeded") ||
    haystack.includes("context overflow")
  );
}

export function isReactiveCompactDroppable(
  message: ConversationMessage,
  messageIndex: number,
  latestUserIndex: number
): boolean {
  if (messageIndex === latestUserIndex) {
    return false;
  }
  if (message.role !== "system") {
    return true;
  }
  if (message.metadata?.pinned === true) {
    return false;
  }
  if (message.metadata?.sourceType === SESSION_TODOS_SOURCE_TYPE) {
    return false;
  }
  return (
    message.metadata?.sourceType === COMPACT_HANDOFF_SOURCE_TYPE ||
    message.content.startsWith("This session is being continued")
  );
}

export function dropOldestCompactibleMessages(
  messages: ConversationMessage[],
  count = 1
): number {
  let dropped = 0;
  while (dropped < count) {
    let latestUserIndex = -1;
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      if (messages[messageIndex]?.role === "user") {
        latestUserIndex = messageIndex;
        break;
      }
    }
    const index = messages.findIndex((message, messageIndex) =>
      isReactiveCompactDroppable(message, messageIndex, latestUserIndex)
    );
    if (index < 0) {
      break;
    }
    let removeCount = 1;
    if (messages[index]?.role === "assistant" && (messages[index]?.toolCalls?.length ?? 0) > 0) {
      while (messages[index + removeCount]?.role === "tool") {
        removeCount += 1;
      }
    }
    messages.splice(index, removeCount);
    dropped += removeCount;
  }
  return dropped;
}

export function dropOldestNonSystemMessages(
  messages: ConversationMessage[],
  count = 1
): number {
  return dropOldestCompactibleMessages(messages, count);
}
