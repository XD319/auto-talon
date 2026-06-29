import type { ConversationMessage } from "../../types/index.js";
import type { ProviderError } from "../../providers/provider-error.js";

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

export function dropOldestNonSystemMessages(
  messages: ConversationMessage[],
  count = 1
): number {
  let dropped = 0;
  while (dropped < count) {
    const index = messages.findIndex((message) => message.role !== "system");
    if (index < 0) {
      break;
    }
    messages.splice(index, 1);
    dropped += 1;
  }
  return dropped;
}
