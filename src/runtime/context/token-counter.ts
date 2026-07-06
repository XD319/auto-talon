import type { ConversationMessage } from "../../types/index.js";

/** Conservative padding over char/4 heuristic (aligned with Claude Code). */
const ESTIMATE_PADDING = 1.33;
const COMPACT_SAFETY_MARGIN = 0.05;

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
  const base = Math.ceil((content.length / 4) * ESTIMATE_PADDING);
  return Math.ceil(base * languageAwareMultiplier(content));
}

function languageAwareMultiplier(content: string): number {
  if (content.length === 0) {
    return 1;
  }
  let cjkCount = 0;
  let codeLikeCount = 0;
  for (const char of content) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/u.test(char)) {
      cjkCount += 1;
    }
    if (char === "{" || char === "}" || char === "[" || char === "]" || char === '"' || char === "\\") {
      codeLikeCount += 1;
    }
  }
  const cjkRatio = cjkCount / content.length;
  const codeRatio = codeLikeCount / content.length;
  let multiplier = 1;
  if (cjkRatio > 0.1) {
    multiplier += cjkRatio * 0.8;
  }
  if (codeRatio > 0.08) {
    multiplier += 0.2;
  }
  return multiplier;
}

export function estimateConversationMessageTokens(message: ConversationMessage): number {
  let total = estimateMessageTokens(message.content ?? "");
  if (Array.isArray(message.toolCalls)) {
    for (const call of message.toolCalls) {
      total += estimateMessageTokens(JSON.stringify(call.input ?? {}));
      if (typeof call.reason === "string") {
        total += estimateMessageTokens(call.reason);
      }
      total += estimateMessageTokens(call.toolCallId);
      total += estimateMessageTokens(call.toolName);
    }
  }
  if (typeof message.toolCallId === "string") {
    total += estimateMessageTokens(message.toolCallId);
  }
  if (typeof message.toolName === "string") {
    total += estimateMessageTokens(message.toolName);
  }
  return total;
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
  _state: HybridTokenCounterState,
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
  const effectiveRatio = Math.max(0, thresholdRatio - COMPACT_SAFETY_MARGIN);
  return Math.max(0, Math.floor(contextWindowTokens * effectiveRatio));
}

export function contextWindowPercentFromPrompt(
  promptTokens: number,
  inputLimit: number,
  reservedOutput: number
): number {
  const usable = Math.max(inputLimit - reservedOutput, 1);
  return Math.min(100, Math.round((promptTokens / usable) * 100));
}
