import { randomUUID } from "node:crypto";

import type { JsonObject, ProviderToolCall } from "../types/index.js";

const TOOL_CALL_BLOCK_RE = /<tool_call>([\s\S]*?)<\/tool_call>/giu;
const ARG_PAIR_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/giu;

/**
 * Parse provider-specific text markup such as:
 * `<tool_call>write_file<arg_key>path</arg_key><arg_value>verify.mjs</arg_value></tool_call>`
 * into structured ProviderToolCall entries when the API omitted JSON tool_calls.
 */
export function parseTextToolCalls(content: string): ProviderToolCall[] {
  const trimmed = content.trim();
  if (trimmed.length === 0 || !trimmed.includes("<tool_call>")) {
    return [];
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const match of trimmed.matchAll(TOOL_CALL_BLOCK_RE)) {
    const body = match[1]?.trim() ?? "";
    if (body.length === 0) {
      continue;
    }

    const firstArgIndex = body.search(/<arg_key>/iu);
    const toolName =
      firstArgIndex === -1 ? body.trim() : body.slice(0, firstArgIndex).trim();
    if (toolName.length === 0 || !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(toolName)) {
      continue;
    }

    const input: JsonObject = {};
    for (const argMatch of body.matchAll(ARG_PAIR_RE)) {
      const key = argMatch[1]?.trim() ?? "";
      const rawValue = argMatch[2] ?? "";
      if (key.length === 0) {
        continue;
      }
      input[key] = parseArgValue(rawValue);
    }

    toolCalls.push({
      input,
      raw: {
        source: "text_tool_call_markup",
        toolName
      },
      reason: `Provider ${toolName} tool call requested.`,
      toolCallId: `text-call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      toolName
    });
  }

  return toolCalls;
}

export function contentLooksLikeTextToolCallMarkup(content: string): boolean {
  const sample = content.trim();
  if (sample.length === 0) {
    return false;
  }
  return (
    /<tool_call>/iu.test(sample) ||
    /<\/tool_call>/iu.test(sample) ||
    /<arg_key>/iu.test(sample) ||
    /<arg_value>/iu.test(sample)
  );
}

function parseArgValue(rawValue: string): JsonObject[string] {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "";
  }
  try {
    return JSON.parse(trimmed) as JsonObject[string];
  } catch {
    return rawValue;
  }
}
