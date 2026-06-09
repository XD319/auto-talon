import type { ConversationMessage } from "../../types/index.js";

import { estimateMessageTokens } from "./token-counter.js";

export interface TailSelectionConfig {
  tailMinMessages: number;
  tailTokenBudget: number;
}

export function selectTailMessages(
  messages: ConversationMessage[],
  config: TailSelectionConfig
): ConversationMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const minKeep = Math.min(config.tailMinMessages, messages.length);
  let startIndex = messages.length - minKeep;
  let usedTokens = estimateMessagesSlice(messages, startIndex);

  while (startIndex > 0) {
    const previousIndex = findPreviousSafeBoundary(messages, startIndex);
    if (previousIndex < 0) {
      break;
    }
    const nextTokens = estimateMessagesSlice(messages, previousIndex);
    if (nextTokens > config.tailTokenBudget) {
      break;
    }
    startIndex = previousIndex;
    usedTokens = nextTokens;
    void usedTokens;
  }

  return messages.slice(startIndex);
}

function estimateMessagesSlice(messages: ConversationMessage[], startIndex: number): number {
  let total = 0;
  for (let index = startIndex; index < messages.length; index += 1) {
    total += estimateMessageTokens(messages[index]?.content ?? "");
  }
  return total;
}

function findPreviousSafeBoundary(messages: ConversationMessage[], startIndex: number): number {
  let index = startIndex - 1;
  while (index >= 0 && messages[index]?.role === "tool") {
    index -= 1;
  }
  if (index < 0) {
    return -1;
  }
  if (messages[index]?.role === "assistant" && (messages[index]?.toolCalls?.length ?? 0) > 0) {
    return index;
  }
  return index;
}
