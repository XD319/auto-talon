import type { ConversationMessage } from "../types/index.js";

function stripToolCalls(message: ConversationMessage): ConversationMessage {
  const { toolCalls: _toolCalls, ...rest } = message;
  return rest;
}

export function normalizeOpenAiCompatibleMessages(
  messages: ConversationMessage[]
): ConversationMessage[] {
  const normalized: ConversationMessage[] = [];
  let pendingToolCallIds: Set<string> | null = null;

  for (const message of messages) {
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      pendingToolCallIds = new Set(message.toolCalls!.map((toolCall) => toolCall.toolCallId));
      normalized.push(message);
      continue;
    }

    if (message.role === "tool") {
      if (
        pendingToolCallIds === null ||
        message.toolCallId === undefined ||
        !pendingToolCallIds.has(message.toolCallId)
      ) {
        continue;
      }
      pendingToolCallIds.delete(message.toolCallId);
      normalized.push(message);
      if (pendingToolCallIds.size === 0) {
        pendingToolCallIds = null;
      }
      continue;
    }

    pendingToolCallIds = null;
    normalized.push(message);
  }

  const repaired: ConversationMessage[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const message = normalized[index]!;
    if (message.role !== "assistant" || (message.toolCalls?.length ?? 0) === 0) {
      repaired.push(message);
      continue;
    }

    const requiredIds = new Set(message.toolCalls!.map((toolCall) => toolCall.toolCallId));
    let scanIndex = index + 1;
    while (scanIndex < normalized.length && normalized[scanIndex]?.role === "tool") {
      const toolCallId = normalized[scanIndex]?.toolCallId;
      if (toolCallId !== undefined) {
        requiredIds.delete(toolCallId);
      }
      scanIndex += 1;
    }

    if (requiredIds.size === message.toolCalls!.length) {
      repaired.push(stripToolCalls(message));
      continue;
    }

    repaired.push(message);
  }

  return repaired;
}
