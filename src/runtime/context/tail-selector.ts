import type { ConversationMessage } from "../../types/index.js";

import { estimateConversationMessageTokens } from "./token-counter.js";

export interface TailSelectionConfig {
  tailMinMessages: number;
  tailTokenBudget: number | null;
  protectLastN?: number;
}

export interface TailSelectionResult {
  budgetExceeded: boolean;
  messages: ConversationMessage[];
  usedTokens: number;
}

export function selectTailMessages(
  messages: ConversationMessage[],
  config: TailSelectionConfig
): TailSelectionResult {
  if (messages.length === 0) {
    return {
      budgetExceeded: false,
      messages: [],
      usedTokens: 0
    };
  }

  const floor = Math.max(config.protectLastN ?? config.tailMinMessages, config.tailMinMessages);
  const minKeep = Math.min(floor, messages.length);
  let startIndex = rewindToToolCallBoundary(messages, messages.length - minKeep);
  let usedTokens = estimateMessagesSlice(messages, startIndex);

  while (startIndex > 0) {
    const previousIndex = findPreviousSafeBoundary(messages, startIndex);
    if (previousIndex < 0) {
      break;
    }
    const nextTokens = estimateMessagesSlice(messages, previousIndex);
    if (config.tailTokenBudget !== null && nextTokens > config.tailTokenBudget) {
      break;
    }
    startIndex = previousIndex;
    usedTokens = nextTokens;
  }

  const budgetExceeded =
    config.tailTokenBudget !== null && usedTokens > config.tailTokenBudget;

  return {
    budgetExceeded,
    messages: messages.slice(startIndex),
    usedTokens
  };
}

function estimateMessagesSlice(messages: ConversationMessage[], startIndex: number): number {
  let total = 0;
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message !== undefined) {
      total += estimateConversationMessageTokens(message);
    }
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

function rewindToToolCallBoundary(
  messages: ConversationMessage[],
  startIndex: number
): number {
  if (messages[startIndex]?.role !== "tool") {
    return startIndex;
  }

  let index = startIndex - 1;
  while (index >= 0 && messages[index]?.role === "tool") {
    index -= 1;
  }
  return messages[index]?.role === "assistant" &&
    (messages[index]?.toolCalls?.length ?? 0) > 0
    ? index
    : startIndex;
}
