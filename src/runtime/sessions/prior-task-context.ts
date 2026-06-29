import type { ConversationMessage, TaskRepository, TokenBudget } from "../../types/index.js";
import type { SessionTaskRepository } from "../../types/index.js";
import { estimateMessagesTokens } from "../context/token-counter.js";

export const PRIOR_TASK_RESULT_SOURCE_TYPE = "prior_task_result";

export function buildPriorTaskContextMessage(input: {
  sessionId: string;
  sessionTaskRepository?: SessionTaskRepository;
  taskRepository?: TaskRepository;
  tokenBudget: TokenBudget;
}): ConversationMessage | null {
  const { sessionId, sessionTaskRepository, taskRepository, tokenBudget } = input;
  if (sessionTaskRepository === undefined || taskRepository === undefined) {
    return null;
  }

  const latestSessionTask = sessionTaskRepository.findLatestBySessionId(sessionId);
  if (latestSessionTask === null) {
    return null;
  }

  const priorTask = taskRepository.findById(latestSessionTask.taskId);
  if (
    priorTask === null ||
    priorTask.finalOutput === null ||
    priorTask.finalOutput.trim().length === 0
  ) {
    return null;
  }

  const truncatedOutput = truncatePriorTaskOutput(priorTask.finalOutput, tokenBudget);
  return {
    content: [
      "PriorTaskResult: The previous completed task in this session produced:",
      truncatedOutput
    ].join("\n"),
    metadata: {
      privacyLevel: "internal",
      retentionKind: "working",
      sourceType: PRIOR_TASK_RESULT_SOURCE_TYPE
    },
    role: "system"
  };
}

export function truncatePriorTaskOutput(output: string, tokenBudget: TokenBudget): string {
  const compact = output.trim();
  if (compact.length === 0) {
    return "";
  }

  const tokenLimit = Math.max(
    250,
    Math.floor((tokenBudget.inputLimit - tokenBudget.reservedOutput) * 0.15)
  );
  let low = 0;
  let high = compact.length;
  let best = compact;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = compact.slice(0, mid);
    const tokens = estimateMessagesTokens([{ content: candidate }]);
    if (tokens <= tokenLimit) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (best.length < compact.length) {
    return `${best}\n...[prior task output truncated]`;
  }
  return best;
}
