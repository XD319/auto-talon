import type { ToolCallFailedPayload } from "../types/index.js";

export function formatToolCallFailureForUser(
  payload: Pick<ToolCallFailedPayload, "errorCode" | "errorMessage" | "toolName">
): string {
  const detail = formatFailureDetail(payload.errorMessage);
  if (payload.errorCode === "tool_execution_error") {
    return `${payload.toolName} failed while executing the requested action: ${detail} This is a tool error, not an AutoTalon runtime failure.`;
  }

  return `${payload.toolName} failed: ${detail}`;
}

function formatFailureDetail(errorMessage: string): string {
  const path = extractMissingPath(errorMessage);
  if (path !== null) {
    return `requested path not found: ${path}.`;
  }

  return `${collapseWhitespace(errorMessage)}.`;
}

function extractMissingPath(errorMessage: string): string | null {
  const singleQuotedPath = /ENOENT:\s*no such file or directory,\s*(?:access|lstat|open|scandir|stat)\s*'([^']+)'/iu.exec(
    errorMessage
  );
  if (singleQuotedPath?.[1] !== undefined) {
    return singleQuotedPath[1];
  }

  const doubleQuotedPath = /ENOENT:\s*no such file or directory,\s*(?:access|lstat|open|scandir|stat)\s*"([^"]+)"/iu.exec(
    errorMessage
  );
  if (doubleQuotedPath?.[1] !== undefined) {
    return doubleQuotedPath[1];
  }

  return null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
