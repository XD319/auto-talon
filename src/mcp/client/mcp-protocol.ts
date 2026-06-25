import { AppError } from "../../core/app-error.js";
import type {
  JsonObject,
  JsonValue,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerConfig,
  McpToolDescriptor
} from "../../types/index.js";

export interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export function parseTools(
  serverId: string,
  result: unknown,
  config: Pick<McpServerConfig, "disabledTools" | "enabledTools">
): McpToolDescriptor[] {
  const payload = asObject(result);
  const tools = asArray(payload.tools);
  return tools
    .map((tool) => {
      const parsed = asObject(tool);
      return {
        description: asString(parsed.description, ""),
        inputSchema: asJsonObject(parsed.inputSchema),
        name: asString(parsed.name),
        serverId
      };
    })
    .filter((tool) => isToolEnabled(tool.name, config));
}

export function parseResources(serverId: string, result: unknown): McpResourceDescriptor[] {
  const payload = asObject(result);
  return asArray(payload.resources).map((resource) => {
    const parsed = asObject(resource);
    const mimeType = parsed.mimeType;
    return {
      description: asString(parsed.description, ""),
      ...(typeof mimeType === "string" ? { mimeType } : {}),
      name: asString(parsed.name, asString(parsed.uri, "")),
      serverId,
      uri: asString(parsed.uri)
    };
  });
}

export function parsePrompts(serverId: string, result: unknown): McpPromptDescriptor[] {
  const payload = asObject(result);
  return asArray(payload.prompts).map((prompt) => {
    const parsed = asObject(prompt);
    return {
      arguments: sanitizeJsonValue(parsed.arguments ?? []) ?? [],
      description: asString(parsed.description, ""),
      name: asString(parsed.name),
      serverId
    };
  });
}

export function normalizeContent(result: unknown): JsonValue {
  const payload = asObject(result);
  return (payload.contents ?? payload.content ?? payload.messages ?? payload) as JsonValue;
}

function isToolEnabled(name: string, config: Pick<McpServerConfig, "disabledTools" | "enabledTools">): boolean {
  if ((config.disabledTools ?? []).includes(name)) {
    return false;
  }
  return (config.enabledTools ?? []).length === 0 || (config.enabledTools ?? []).includes(name);
}

export function startupTimeoutMs(config: Pick<McpServerConfig, "startupTimeoutMs">): number {
  return config.startupTimeoutMs ?? 10_000;
}

export function toolTimeoutMs(config: Pick<McpServerConfig, "toolTimeoutMs">): number {
  return config.toolTimeoutMs ?? 60_000;
}

export function parseJsonRpcLines(raw: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const line of raw.split(/\r?\n/gu)) {
    const text = line.trim();
    if (text.length === 0) {
      continue;
    }
    try {
      messages.push(JSON.parse(text) as JsonRpcMessage);
    } catch {
      continue;
    }
  }
  return messages;
}

export function formatMalformedJsonRpcError(serverId: string, line: string): string {
  return `MCP ${serverId} returned malformed JSON: ${truncateJsonRpcLine(line)}`;
}

export function truncateJsonRpcLine(line: string, maxLength = 120): string {
  if (line.length <= maxLength) {
    return line;
  }
  return `${line.slice(0, maxLength)}...`;
}

export function jsonRpcError(
  serverId: string,
  method: string,
  error: NonNullable<JsonRpcMessage["error"]>
): AppError {
  return new AppError({
    code: "tool_execution_error",
    details: { error, method, serverId },
    message: `MCP ${serverId}/${method} failed: ${error.message ?? "unknown error"}`
  });
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asJsonObject(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return sanitizeJsonObject(value as Record<string, unknown>);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback?: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new AppError({
    code: "tool_execution_error",
    message: "Invalid MCP response shape."
  });
}

function sanitizeJsonObject(value: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = sanitizeJsonValue(entry);
    if (normalized !== undefined) {
      output[key] = normalized;
    }
  }
  return output;
}

function sanitizeJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }
  if (typeof value === "object") {
    return sanitizeJsonObject(value as Record<string, unknown>);
  }
  return undefined;
}
