export type StatusTone = "accent" | "danger" | "muted" | "neutral" | "success" | "warn";

export type UiRunState =
  | "failed"
  | "idle"
  | "interrupted"
  | "running"
  | "succeeded"
  | "waiting_approval"
  | "waiting_clarification";

export interface UiStatus {
  primaryLabel: string;
  primaryTone: StatusTone;
  runState: UiRunState;
  taskLabel: string | null;
}
