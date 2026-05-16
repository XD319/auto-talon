import type {
  JsonObject,
  Provider,
  ProviderStatsSnapshot,
  ProviderUsage,
  TaskRecord,
  TraceEvent
} from "../../types/index.js";

export interface ProviderStatsServiceDependencies {
  listTasks: () => TaskRecord[];
  listTrace: (taskId: string) => TraceEvent[];
  provider: Provider;
}

export class ProviderStatsService {
  public constructor(private readonly dependencies: ProviderStatsServiceDependencies) {}

  public providerStats(
    groupBy: "provider" | "thread" | "task" | "mode" = "provider"
  ): ProviderStatsSnapshot | null | JsonObject {
    const liveStats = this.dependencies.provider.getStats?.() ?? null;
    if (groupBy !== "provider") {
      return this.providerStatsBy(groupBy);
    }
    if (liveStats !== null && liveStats.totalRequests > 0) {
      return {
        ...liveStats,
        source: "live"
      };
    }

    const traceStats = buildProviderStatsFromTrace(
      this.dependencies.provider.name,
      this.dependencies.listTasks().flatMap((task) => this.dependencies.listTrace(task.taskId))
    );
    return traceStats.totalRequests > 0
      ? {
          ...traceStats,
          source: "trace"
        }
      : liveStats;
  }

  private providerStatsBy(groupBy: "thread" | "task" | "mode"): JsonObject {
    const events = this.dependencies
      .listTasks()
      .flatMap((task) => this.dependencies.listTrace(task.taskId))
      .filter((event) => event.eventType === "cost_report");
    const grouped: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; count: number }> = {};
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const key =
        groupBy === "task"
          ? event.taskId
          : groupBy === "thread"
            ? readGroupingKey(payload.threadId, "none")
            : readGroupingKey(payload.mode, "balanced");
      const row = grouped[key] ?? { costUsd: 0, count: 0, inputTokens: 0, outputTokens: 0 };
      row.count += 1;
      row.inputTokens += Number(payload.inputTokens ?? 0);
      row.outputTokens += Number(payload.outputTokens ?? 0);
      row.costUsd += Number(payload.costUsd ?? 0);
      grouped[key] = row;
    }
    return grouped as JsonObject;
  }
}

function readGroupingKey(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function buildProviderStatsFromTrace(
  providerName: string,
  trace: TraceEvent[]
): ProviderStatsSnapshot {
  const providerEvents = trace.filter(
    (event) =>
      event.eventType === "provider_request_succeeded" ||
      event.eventType === "provider_request_failed"
  );
  const successes = providerEvents.filter((event) => event.eventType === "provider_request_succeeded");
  const failures = providerEvents.filter((event) => event.eventType === "provider_request_failed");
  const totalLatency = providerEvents.reduce((sum, event) => {
    if (event.eventType === "provider_request_succeeded" || event.eventType === "provider_request_failed") {
      return sum + event.payload.latencyMs;
    }
    return sum;
  }, 0);
  const retryCount = providerEvents.reduce((sum, event) => {
    if (event.eventType === "provider_request_succeeded" || event.eventType === "provider_request_failed") {
      return sum + event.payload.retryCount;
    }
    return sum;
  }, 0);
  const tokenUsage = successes.reduce<ProviderUsage>(
    (usage, event) => {
      if (event.eventType !== "provider_request_succeeded") {
        return usage;
      }
      const payload = event.payload.usage;
      const inputTokens = readNumber(payload?.inputTokens);
      const outputTokens = readNumber(payload?.outputTokens);
      const totalTokens = readNumber(payload?.totalTokens);
      const cachedInputTokens = readNumber(payload?.cachedInputTokens);
      return {
        cachedInputTokens: (usage.cachedInputTokens ?? 0) + (cachedInputTokens ?? 0),
        inputTokens: usage.inputTokens + (inputTokens ?? 0),
        outputTokens: usage.outputTokens + (outputTokens ?? 0),
        totalTokens:
          (usage.totalTokens ?? usage.inputTokens + usage.outputTokens) +
          (totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0))
      };
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
  );
  const lastRequestAt = providerEvents.at(-1)?.timestamp ?? null;
  const lastFailure = [...failures].reverse()[0];

  return {
    averageLatencyMs:
      providerEvents.length === 0 ? 0 : Number((totalLatency / providerEvents.length).toFixed(2)),
    failedRequests: failures.length,
    lastErrorCategory:
      lastFailure?.eventType === "provider_request_failed" ? lastFailure.payload.errorCategory : null,
    lastRequestAt,
    providerName,
    retryCount,
    successfulRequests: successes.length,
    tokenUsage,
    totalRequests: providerEvents.length
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
