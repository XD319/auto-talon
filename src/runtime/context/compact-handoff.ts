import type { ConversationMessage } from "../../types/index.js";

export function countCompactedMessageRoles(messages: ConversationMessage[]): {
  assistant: number;
  tool: number;
  total: number;
  user: number;
} {
  const counts = {
    assistant: 0,
    tool: 0,
    total: messages.length,
    user: 0
  };
  for (const message of messages) {
    if (message.role === "user") {
      counts.user += 1;
    } else if (message.role === "assistant") {
      counts.assistant += 1;
    } else if (message.role === "tool") {
      counts.tool += 1;
    }
  }
  return counts;
}

export function listDiscardedMessages(
  allMessages: ConversationMessage[],
  preservedMessages: ConversationMessage[]
): ConversationMessage[] {
  const preservedIndices = collectPreservedIndices(allMessages, preservedMessages);
  return allMessages.filter((_, index) => !preservedIndices.has(index));
}

export function collectPreservedIndices(
  allMessages: ConversationMessage[],
  preservedMessages: ConversationMessage[]
): Set<number> {
  const preservedIndices = new Set<number>();
  for (const preserved of preservedMessages) {
    for (let index = 0; index < allMessages.length; index += 1) {
      if (preservedIndices.has(index)) {
        continue;
      }
      const message = allMessages[index];
      if (message?.role === preserved.role && message.content === preserved.content) {
        preservedIndices.add(index);
        break;
      }
    }
  }
  return preservedIndices;
}

export function buildSessionHandoffMessageContent(input: {
  compactedMessages: ConversationMessage[];
  summary: string;
}): string {
  const counts = countCompactedMessageRoles(input.compactedMessages);
  return [
    "This session is being continued from a previous conversation.",
    "The summary below covers earlier work. Recent messages and todos are preserved.",
    "Continue without re-asking what the user wants. Do not repeat completed work.",
    `Compacted ${counts.total} earlier messages (user=${counts.user}, assistant=${counts.assistant}, tool=${counts.tool}).`,
    "",
    "Session handoff:",
    input.summary
  ].join("\n");
}
