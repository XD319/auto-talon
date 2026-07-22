import { randomUUID } from "node:crypto";

import type {
  ConversationMessage,
  Provider,
  TaskRecord,
  TokenBudget,
  ToolExecutionContext
} from "../types/index.js";
import type { ToolOrchestrator } from "../tools/tool-orchestrator.js";

/**
 * Non-blocking post-task memory review (Hermes-style background review).
 * Queues memory suggestions via the memory tool; never writes approved memory directly.
 */
export class MemoryBackgroundReviewService {
  private readonly inFlight = new Set<string>();

  public constructor(
    private readonly options: {
      enabled: () => boolean;
      maxSuggestions: number;
      timeoutMs?: number;
      toolOrchestrator: ToolOrchestrator;
      workspaceRoot: string;
    }
  ) {}

  public schedule(input: {
    provider: Provider;
    task: TaskRecord;
    messages: ConversationMessage[];
    iteration: number;
    tokenBudget: TokenBudget;
    signal?: AbortSignal;
  }): void {
    if (!this.options.enabled() || this.inFlight.has(input.task.taskId)) {
      return;
    }
    this.inFlight.add(input.task.taskId);
    void this.run(input)
      .catch(() => 0)
      .finally(() => {
        this.inFlight.delete(input.task.taskId);
      });
  }

  public async run(input: {
    provider: Provider;
    task: TaskRecord;
    messages: ConversationMessage[];
    iteration: number;
    tokenBudget: TokenBudget;
    signal?: AbortSignal;
  }): Promise<number> {
    if (!this.options.enabled()) {
      return 0;
    }
    const memoryTools = this.options.toolOrchestrator.listTools(["memory"]);
    if (memoryTools.length === 0) {
      return 0;
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 12_000);
    try {
      const response = await input.provider.generate({
        task: input.task,
        iteration: input.iteration,
        agentProfileId: input.task.agentProfileId,
        availableTools: memoryTools,
        memoryContext: [],
        tokenBudget: input.tokenBudget,
        signal: controller.signal,
        messages: [
          {
            role: "system",
            content: [
              "Background memory review only.",
              `Suggest at most ${this.options.maxSuggestions} stable, safe core-memory changes using the memory tool.`,
              "Do not continue the task and do not call other tools.",
              "Save only stable preferences, project conventions, environment facts, corrections, or important decisions.",
              "Never save logs, temporary state, credentials, or reconstructable facts.",
              "If nothing is worth remembering, call no tools."
            ].join(" ")
          },
          ...input.messages.slice(-16)
        ]
      });
      if (response.kind !== "tool_calls") {
        return 0;
      }
      let accepted = 0;
      for (const call of response.toolCalls
        .filter((item) => item.toolName === "memory")
        .slice(0, this.options.maxSuggestions)) {
        const context: ToolExecutionContext = {
          taskId: input.task.taskId,
          iteration: input.iteration,
          workspaceRoot: this.options.workspaceRoot,
          cwd: input.task.cwd,
          userId: input.task.requesterUserId,
          agentProfileId: input.task.agentProfileId,
          taskMetadata: {
            ...input.task.metadata,
            ...(input.task.sessionId !== null && input.task.sessionId !== undefined
              ? { sessionId: input.task.sessionId }
              : {})
          },
          signal: controller.signal
        };
        const outcome = await this.options.toolOrchestrator.execute(
          {
            taskId: input.task.taskId,
            iteration: input.iteration,
            toolCallId: call.toolCallId || randomUUID(),
            toolName: "memory",
            input: call.input,
            reason: call.reason || "post-task memory review"
          },
          context
        );
        if (outcome.kind === "completed" && outcome.result.success) {
          accepted += 1;
        }
      }
      return accepted;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }
}
