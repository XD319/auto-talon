export const WORKER_KINDS = ["summarizer", "retrieval"] as const;

export type WorkerKind = (typeof WORKER_KINDS)[number];

export const WORKER_STATUSES = [
  "dispatched",
  "running",
  "succeeded",
  "failed",
  "timeout",
  "retried",
  "skipped"
] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export interface WorkerRequest<TInput> {
  workerId: string;
  workerKind: WorkerKind;
  taskId: string;
  threadId: string | null;
  input: TInput;
  timeoutMs: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export interface WorkerResult<TOutput> {
  workerId: string;
  workerKind: WorkerKind;
  status: WorkerStatus;
  output: TOutput | null;
  durationMs: number;
  attemptNumber: number;
  errorMessage: string | null;
}

