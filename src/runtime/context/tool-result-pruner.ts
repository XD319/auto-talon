import type { ConversationMessage } from "../../types/index.js";

import { estimateMessageTokens } from "./token-counter.js";

export const CLEARED_TOOL_RESULT_MARKER =
  "[prior tool result cleared — use conversation context or re-invoke only if needed]";

export const DEFAULT_TOOL_RESULT_KEEP_GROUPS = 5;

export interface ToolResultPruneResult {
  prunedCount: number;
  savedTokensEstimate: number;
}

export function pruneOldToolResults(
  messages: ConversationMessage[],
  keepGroups = DEFAULT_TOOL_RESULT_KEEP_GROUPS
): ToolResultPruneResult {
  const toolIndices: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "tool") {
      toolIndices.push(index);
    }
  }

  if (toolIndices.length <= keepGroups) {
    return {
      prunedCount: 0,
      savedTokensEstimate: 0
    };
  }

  const toPrune = toolIndices.slice(0, toolIndices.length - keepGroups);
  let prunedCount = 0;
  let savedTokensEstimate = 0;

  for (const index of toPrune) {
    const message = messages[index];
    if (message === undefined || message.content === CLEARED_TOOL_RESULT_MARKER) {
      continue;
    }
    savedTokensEstimate += estimateMessageTokens(message.content);
    messages[index] = {
      ...message,
      content: CLEARED_TOOL_RESULT_MARKER
    };
    prunedCount += 1;
  }

  return {
    prunedCount,
    savedTokensEstimate
  };
}
