import { AppError } from "../app-error.js";
import { computeCostUsd } from "../budget/cost-calculator.js";
import type { BudgetService } from "../budget/budget-service.js";
import type {
  BudgetPricingEntry,
  ProviderResponse,
  TaskRecord,
  TaskRepository,
  TokenBudget,
  TraceEventDraft
} from "../../types/index.js";

export interface BudgetRecorderDependencies {
  budgetPricing?: Record<string, BudgetPricingEntry>;
  budgetService?: BudgetService;
  mode: "cheap_first" | "balanced" | "quality_first";
  recordTrace(event: TraceEventDraft): void;
  taskRepository: TaskRepository;
}

export interface BudgetRecorderInput {
  providerName: string;
  providerResponse: ProviderResponse;
  task: TaskRecord;
  tokenBudget: TokenBudget;
}

export interface BudgetRecorderResult {
  task: TaskRecord;
  tokenBudget: TokenBudget;
}

export class BudgetRecorder {
  public constructor(private readonly dependencies: BudgetRecorderDependencies) {}

  public record(input: BudgetRecorderInput): BudgetRecorderResult {
    const pricing = this.dependencies.budgetPricing?.[input.providerName];
    const costUsd = computeCostUsd(input.providerResponse.usage, pricing);
    const tokenBudget = {
      ...input.tokenBudget,
      usedCostUsd: (input.tokenBudget.usedCostUsd ?? 0) + (costUsd ?? 0),
      usedInput: (input.tokenBudget.usedInput ?? 0) + input.providerResponse.usage.inputTokens,
      usedOutput: (input.tokenBudget.usedOutput ?? 0) + input.providerResponse.usage.outputTokens
    };
    const task = this.dependencies.taskRepository.update(input.task.taskId, {
      tokenBudget
    });
    this.dependencies.recordTrace({
      actor: "runtime.budget",
      eventType: "cost_report",
      payload: {
        cachedInputTokens: input.providerResponse.usage.cachedInputTokens ?? 0,
        costUsd,
        inputTokens: input.providerResponse.usage.inputTokens,
        mode: this.dependencies.mode,
        outputTokens: input.providerResponse.usage.outputTokens,
        providerName: input.providerName,
        taskId: task.taskId,
        sessionId: task.sessionId ?? null
      },
      stage: "control",
      summary: "Cost usage recorded",
      taskId: task.taskId
    });
    const budgetDecision = this.dependencies.budgetService?.recordUsage({
      costUsd,
      mode: this.dependencies.mode,
      taskId: task.taskId,
      sessionId: task.sessionId ?? null,
      usage: input.providerResponse.usage
    });
    if (budgetDecision?.action === "hard_abort") {
      throw new AppError({
        code: "budget_exceeded",
        message: budgetDecision.reasons.join("; ") || "Budget hard limit exceeded."
      });
    }
    return { task, tokenBudget };
  }
}
