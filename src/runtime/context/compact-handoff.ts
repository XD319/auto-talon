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
  return allMessages.filter(
    (message) =>
      !preservedMessages.some(
        (preserved) => preserved.role === message.role && preserved.content === message.content
      )
  );
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
