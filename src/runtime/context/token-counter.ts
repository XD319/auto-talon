import type { ConversationMessage } from "../../types/index.js";

/** Conservative padding over char/4 heuristic (aligned with Claude Code). */
const ESTIMATE_PADDING = 1.33;

export interface HybridTokenCounterState {
  lastApiInputTokens: number;
  messageCountAtLastApi: number;
}

export function createHybridTokenCounterState(): HybridTokenCounterState {
  return {
    lastApiInputTokens: 0,
    messageCountAtLastApi: 0
  };
}

export function estimateMessageTokens(content: string): number {
  return Math.ceil((content.length / 4) * ESTIMATE_PADDING);
}

export function estimateMessagesTokens(messages: Array<{ content: string }>): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message.content), 0);
}

export function computePromptTokens(
  state: HybridTokenCounterState,
  messages: ConversationMessage[]
): number {
  const deltaMessages = messages.slice(state.messageCountAtLastApi);
  return state.lastApiInputTokens + estimateMessagesTokens(deltaMessages);
}

export function recordApiUsage(
  state: HybridTokenCounterState,
  inputTokens: number,
  messageCount: number
): HybridTokenCounterState {
  return {
    lastApiInputTokens: inputTokens,
    messageCountAtLastApi: messageCount
  };
}

export function computeEffectiveWindow(inputLimit: number, reservedOutput: number): number {
  return Math.max(0, inputLimit - reservedOutput);
}

export function computeCompactThreshold(inputLimit: number, thresholdRatio: number): number {
  return computeHermesCompactThreshold(inputLimit, thresholdRatio);
}

export function computeHermesCompactThreshold(
  contextWindowTokens: number,
  thresholdRatio: number
): number {
  return Math.max(0, Math.floor(contextWindowTokens * thresholdRatio));
}

export function computeHeadroom(
  promptTokens: number,
  inputLimit: number,
  reservedOutput: number,
  bufferTokens: number
): number {
  const effective = computeEffectiveWindow(inputLimit, reservedOutput);
  return effective - promptTokens - bufferTokens;
}

export function contextWindowPercentFromPrompt(
  promptTokens: number,
  inputLimit: number,
  reservedOutput: number
): number {
  const usable = Math.max(inputLimit - reservedOutput, 1);
  return Math.min(100, Math.round((promptTokens / usable) * 100));
}
