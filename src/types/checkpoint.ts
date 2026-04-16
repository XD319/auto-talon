import type { ConversationMessage, ProviderToolCall } from "./runtime";

export interface ExecutionCheckpointRecord {
  taskId: string;
  iteration: number;
  memoryContext: string[];
  messages: ConversationMessage[];
  pendingToolCalls: ProviderToolCall[];
  updatedAt: string;
}
