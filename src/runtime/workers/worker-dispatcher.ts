import { planRetry } from "../jobs/backoff.js";
import type { AuditService } from "../../audit/audit-service.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { BudgetService } from "../budget/budget-service.js";
import type { WorkerRequest, WorkerResult } from "../../types/index.js";

export interface WorkerHandlerContext {
  signal: AbortSignal;
  attemptNumber: number;
}

export type WorkerHandler<TInput, TOutput> = (
  input: TInput,
  context: WorkerHandlerContext
) => Promise<TOutput>;

export interface WorkerDispatchOptions {
  actor?: string;
}

export interface WorkerDispatcherDependencies {
  traceService: TraceService;
  auditService: AuditService;
  budgetService?: BudgetService;
}

export class WorkerDispatcher {
  public constructor(private readonly dependencies: WorkerDispatcherDependencies) {}

  public async dispatch<TInput, TOutput>(
    request: WorkerRequest<TInput>,
    handler: WorkerHandler<TInput, TOutput>,
    options: WorkerDispatchOptions = {}
  ): Promise<WorkerResult<TOutput>> {
    const actor = options.actor ?? `runtime.worker.${request.workerKind}`;
    if (this.shouldSkipForBudget(request.taskId, request.threadId)) {
      const message = "Worker skipped due to active budget downgrade.";
      this.safeTrace({
        actor,
        eventType: "worker_failed",
        payload: {
          durationMs: 0,
          errorMessage: message,
          retriable: false,
          taskId: request.taskId,
          threadId: request.threadId,
          workerId: request.workerId,
          workerKind: request.workerKind
        },
        stage: "control",
        summary: message,
        taskId: request.taskId
      });
      this.safeAudit({
        action: "worker_failed",
        actor,
        approvalId: null,
        outcome: "denied",
        payload: {
          reason: "budget_downgrade_active",
          taskId: request.taskId,
          threadId: request.threadId,
          workerId: request.workerId,
          workerKind: request.workerKind
        },
        summary: message,
        taskId: request.taskId,
        toolCallId: null
      });
      return {
        attemptNumber: 1,
        durationMs: 0,
        errorMessage: message,
        output: null,
        status: "skipped",
        workerId: request.workerId,
        workerKind: request.workerKind
      };
    }

    let attempt = 1;
    while (attempt <= request.maxAttempts) {
      const startedAt = Date.now();
      this.safeTrace({
        actor,
        eventType: "worker_dispatched",
        payload: {
          taskId: request.taskId,
          threadId: request.threadId,
          timeoutMs: request.timeoutMs,
          workerId: request.workerId,
          workerKind: request.workerKind
        },
        stage: "control",
        summary: `Worker ${request.workerKind} dispatched`,
        taskId: request.taskId
      });
      this.safeAudit({
        action: "worker_dispatched",
        actor,
        approvalId: null,
        outcome: "attempted",
        payload: {
          attemptNumber: attempt,
          taskId: request.taskId,
          threadId: request.threadId,
          timeoutMs: request.timeoutMs,
          workerId: request.workerId,
          workerKind: request.workerKind
        },
        summary: `Worker ${request.workerKind} dispatched`,
        taskId: request.taskId,
        toolCallId: null
      });

      try {
        const output = await this.runWithTimeout(handler, request.input, request.timeoutMs, attempt);
        const durationMs = Date.now() - startedAt;
        this.safeTrace({
          actor,
          eventType: "worker_succeeded",
          payload: {
            durationMs,
            outputSummary: summarizeOutput(output),
            taskId: request.taskId,
            threadId: request.threadId,
            workerId: request.workerId,
            workerKind: request.workerKind
          },
          stage: "completion",
          summary: `Worker ${request.workerKind} succeeded`,
          taskId: request.taskId
        });
        return {
          attemptNumber: attempt,
          durationMs,
          errorMessage: null,
          output,
          status: "succeeded",
          workerId: request.workerId,
          workerKind: request.workerKind
        };
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const isTimeout = error instanceof WorkerTimeoutError;
        const errorMessage =
          error instanceof Error ? error.message : `Unknown ${request.workerKind} worker failure`;
        const canRetry = !isTimeout && attempt < request.maxAttempts;
        this.safeTrace({
          actor,
          eventType: isTimeout ? "worker_timeout" : "worker_failed",
          payload: isTimeout
            ? {
                taskId: request.taskId,
                threadId: request.threadId,
                timeoutMs: request.timeoutMs,
                workerId: request.workerId,
                workerKind: request.workerKind
              }
            : {
                durationMs,
                errorMessage,
                retriable: canRetry,
                taskId: request.taskId,
                threadId: request.threadId,
                workerId: request.workerId,
                workerKind: request.workerKind
              },
          stage: "completion",
          summary: isTimeout
            ? `Worker ${request.workerKind} timed out`
            : `Worker ${request.workerKind} failed`,
          taskId: request.taskId
        });
        this.safeAudit({
          action: "worker_failed",
          actor,
          approvalId: null,
          outcome: isTimeout ? "timed_out" : "failed",
          payload: {
            attemptNumber: attempt,
            durationMs,
            errorMessage,
            retriable: canRetry,
            taskId: request.taskId,
            threadId: request.threadId,
            timeoutMs: request.timeoutMs,
            workerId: request.workerId,
            workerKind: request.workerKind
          },
          summary: isTimeout
            ? `Worker ${request.workerKind} timed out`
            : `Worker ${request.workerKind} failed`,
          taskId: request.taskId,
          toolCallId: null
        });

        if (!canRetry) {
          return {
            attemptNumber: attempt,
            durationMs,
            errorMessage,
            output: null,
            status: isTimeout ? "timeout" : "failed",
            workerId: request.workerId,
            workerKind: request.workerKind
          };
        }

        const retry = planRetry(
          {
            backoffBaseMs: request.backoffBaseMs,
            backoffMaxMs: request.backoffMaxMs,
            maxAttempts: request.maxAttempts
          },
          { attemptNumber: attempt }
        );
        if (retry === null) {
          return {
            attemptNumber: attempt,
            durationMs,
            errorMessage,
            output: null,
            status: "failed",
            workerId: request.workerId,
            workerKind: request.workerKind
          };
        }
        this.safeTrace({
          actor,
          eventType: "worker_retried",
          payload: {
            attemptNumber: attempt + 1,
            delayMs: retry.delayMs,
            maxAttempts: request.maxAttempts,
            taskId: request.taskId,
            threadId: request.threadId,
            workerId: request.workerId,
            workerKind: request.workerKind
          },
          stage: "control",
          summary: `Worker ${request.workerKind} retry scheduled`,
          taskId: request.taskId
        });
        await sleep(retry.delayMs);
      }
      attempt += 1;
    }

    return {
      attemptNumber: request.maxAttempts,
      durationMs: 0,
      errorMessage: "Worker attempts exhausted.",
      output: null,
      status: "failed",
      workerId: request.workerId,
      workerKind: request.workerKind
    };
  }

  private shouldSkipForBudget(taskId: string, threadId: string | null): boolean {
    if (this.dependencies.budgetService === undefined) {
      return false;
    }
    if (this.dependencies.budgetService.isDowngradeActive("task", taskId)) {
      return true;
    }
    if (threadId !== null && this.dependencies.budgetService.isDowngradeActive("thread", threadId)) {
      return true;
    }
    return false;
  }

  private async runWithTimeout<TInput, TOutput>(
    handler: WorkerHandler<TInput, TOutput>,
    input: TInput,
    timeoutMs: number,
    attemptNumber: number
  ): Promise<TOutput> {
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          abortController.abort();
          reject(new WorkerTimeoutError(`Worker timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      return await Promise.race([
        handler(input, {
          attemptNumber,
          signal: abortController.signal
        }),
        timeoutPromise
      ]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private safeTrace(event: Parameters<TraceService["record"]>[0]): void {
    try {
      this.dependencies.traceService.record(event);
    } catch {
      // Worker operation should not fail because tracing failed.
    }
  }

  private safeAudit(event: Parameters<AuditService["record"]>[0]): void {
    try {
      this.dependencies.auditService.record(event);
    } catch {
      // Worker operation should not fail because audit persistence failed.
    }
  }
}

class WorkerTimeoutError extends Error {}

function summarizeOutput(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return value.length <= 200 ? value : `${value.slice(0, 200)}...`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return typeof value;
  }
  return serialized.length <= 200 ? serialized : `${serialized.slice(0, 200)}...`;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

