import type { ProviderToolCall, ToolDefinition } from "../types/index.js";

export function isMutationTool(tool: ToolDefinition): boolean {
  return (
    tool.capability === "interaction.ask_user" ||
    tool.capability === "filesystem.write" ||
    tool.sideEffectLevel === "runtime_mutation" ||
    tool.sideEffectLevel === "workspace_mutation" ||
    tool.sideEffectLevel === "external_mutation"
  );
}

export function isParallelSafeTool(tool: ToolDefinition): boolean {
  return !isMutationTool(tool);
}

export type ToolCallExecutionBatch =
  | { kind: "parallel"; toolCalls: ProviderToolCall[] }
  | { kind: "serial"; toolCall: ProviderToolCall };

export function groupToolCallsIntoBatches(
  toolCalls: ProviderToolCall[],
  isParallelSafe: (toolName: string) => boolean
): ToolCallExecutionBatch[] {
  const batches: ToolCallExecutionBatch[] = [];
  let parallelBuffer: ProviderToolCall[] = [];

  const flushParallel = (): void => {
    if (parallelBuffer.length === 0) {
      return;
    }
    batches.push({ kind: "parallel", toolCalls: parallelBuffer });
    parallelBuffer = [];
  };

  for (const toolCall of toolCalls) {
    if (isParallelSafe(toolCall.toolName)) {
      parallelBuffer.push(toolCall);
      continue;
    }
    flushParallel();
    batches.push({ kind: "serial", toolCall });
  }

  flushParallel();
  return batches;
}

export function buildParallelSafeLookup(
  tools: ToolDefinition[]
): Map<string, boolean> {
  return new Map(tools.map((tool) => [tool.name, isParallelSafeTool(tool)]));
}
