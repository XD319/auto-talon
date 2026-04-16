import type { JsonObject } from "./common";
import type { PathScope } from "./governance";

export interface SandboxFileAccessPlan extends JsonObject {
  kind: "file";
  operation: "read" | "write";
  requestedPath: string;
  resolvedPath: string;
  pathScope: PathScope;
}

export interface SandboxShellPlan extends JsonObject {
  kind: "shell";
  command: string;
  executable: string;
  cwd: string;
  envKeys: string[];
  timeoutMs: number;
  pathScope: PathScope;
  networkAccess: "disabled";
}

export interface SandboxWebPlan extends JsonObject {
  kind: "network";
  method: "GET";
  url: string;
  host: string;
  pathScope: "network";
  networkAccess: "controlled";
}

export type SandboxExecutionPlan =
  | SandboxFileAccessPlan
  | SandboxShellPlan
  | SandboxWebPlan;
