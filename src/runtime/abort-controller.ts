import { AppError } from "./app-error.js";

export type AbortReason = "interrupt" | "timeout";
export type TimeoutMode = "activity" | "wall_clock";

export interface ManagedAbortController {
  abortController: AbortController;
  dispose: () => void;
  getReason: () => AbortReason | null;
  getLastActivityAt: () => number;
  getLastActivityReason: () => string | null;
  timeoutMode: TimeoutMode;
  timeoutMs: number;
  touchActivity: (activityReason: string) => void;
}

export function createManagedAbortController(
  timeoutMs: number,
  upstreamSignal?: AbortSignal,
  options: {
    mode?: TimeoutMode;
    now?: () => number;
    onInactivityWarning?: (details: {
      lastActivityAt: number;
      lastActivityReason: string | null;
      timeoutMs: number;
      warningAfterMs: number;
    }) => void;
  } = {}
): ManagedAbortController {
  const abortController = new AbortController();
  let reason: AbortReason | null = null;
  const mode = options.mode ?? "wall_clock";
  const now = options.now ?? Date.now;
  let lastActivityAt = now();
  let lastActivityReason: string | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let warning: ReturnType<typeof setTimeout> | undefined;
  let warningEmitted = false;
  const warningAfterMs = Math.max(1, Math.floor(timeoutMs * 0.75));

  const abort = (nextReason: AbortReason): void => {
    if (!abortController.signal.aborted) {
      reason = nextReason;
      abortController.abort(nextReason);
    }
  };

  const clearTimers = (): void => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (warning !== undefined) {
      clearTimeout(warning);
      warning = undefined;
    }
  };

  const scheduleTimers = (): void => {
    clearTimers();
    const elapsedMs = Math.max(0, now() - lastActivityAt);
    const timeoutRemainingMs = Math.max(0, timeoutMs - elapsedMs);
    timeout = setTimeout(() => abort("timeout"), timeoutRemainingMs);
    if (
      mode === "activity" &&
      options.onInactivityWarning !== undefined &&
      !warningEmitted &&
      elapsedMs < warningAfterMs
    ) {
      warning = setTimeout(() => {
        warningEmitted = true;
        options.onInactivityWarning?.({
          lastActivityAt,
          lastActivityReason,
          timeoutMs,
          warningAfterMs
        });
      }, warningAfterMs - elapsedMs);
    }
  };

  const onAbort = (): void => {
    abort("interrupt");
  };

  upstreamSignal?.addEventListener("abort", onAbort);
  scheduleTimers();

  return {
    abortController,
    dispose: () => {
      clearTimers();
      upstreamSignal?.removeEventListener("abort", onAbort);
    },
    getLastActivityAt: () => lastActivityAt,
    getLastActivityReason: () => lastActivityReason,
    getReason: () => reason,
    timeoutMode: mode,
    timeoutMs,
    touchActivity: (activityReason: string) => {
      if (mode !== "activity" || abortController.signal.aborted) {
        return;
      }
      lastActivityAt = now();
      lastActivityReason = activityReason;
      warningEmitted = false;
      scheduleTimers();
    }
  };
}

export function throwIfAborted(signal: AbortSignal, reason: AbortReason | null): void {
  if (signal.aborted) {
    throw new AppError({
      code: reason === "timeout" ? "timeout" : "interrupt",
      message:
        reason === "timeout"
          ? "Task timed out after inactivity."
          : "Task interrupted by signal."
    });
  }
}
