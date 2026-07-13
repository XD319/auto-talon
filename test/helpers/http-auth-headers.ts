import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "../../src/runtime/workspace-layout.js";

export function readWorkspaceHttpToken(workspaceRoot: string): string {
  return readFileSync(join(resolveWorkspaceLayout(workspaceRoot).stateRoot, "http.token"), "utf8").trim();
}

export function workspaceAuthHeaders(workspaceRoot: string): Record<string, string> {
  return {
    Authorization: `Bearer ${readWorkspaceHttpToken(workspaceRoot)}`
  };
}

export function withWorkspaceAuthHeaders(
  workspaceRoot: string,
  headers: Record<string, string> = {}
): Record<string, string> {
  return {
    ...headers,
    ...workspaceAuthHeaders(workspaceRoot)
  };
}
