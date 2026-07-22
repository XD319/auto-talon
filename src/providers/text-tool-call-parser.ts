import { randomUUID } from "node:crypto";

import type { JsonObject, ProviderToolCall } from "../types/index.js";

const TOOL_CALL_OPEN = "<tool_call>";
const TOOL_CALL_CLOSE = "</tool_call>";
const ARG_KEY_OPEN = "<arg_key>";
const ARG_KEY_CLOSE = "</arg_key>";
const ARG_VALUE_OPEN = "<arg_value>";
const ARG_VALUE_CLOSE = "</arg_value>";

/**
 * Parse provider-specific text markup such as:
 * `<tool_call>write_file<arg_key>path</arg_key><arg_value>verify.mjs</arg_value></tool_call>`
 * into structured ProviderToolCall entries when the API omitted JSON tool_calls.
 *
 * Closing tags use the last match before the next sibling open tag so content that
 * itself contains `</arg_value>` or `</tool_call>` is not truncated early.
 */
export function parseTextToolCalls(content: string): ProviderToolCall[] {
  const trimmed = content.trim();
  if (trimmed.length === 0 || !trimmed.toLowerCase().includes(TOOL_CALL_OPEN)) {
    return [];
  }

  const toolCalls: ProviderToolCall[] = [];
  for (const body of extractBlocks(trimmed, TOOL_CALL_OPEN, TOOL_CALL_CLOSE)) {
    const firstArgIndex = body.search(/<arg_key>/iu);
    const toolName =
      firstArgIndex === -1 ? body.trim() : body.slice(0, firstArgIndex).trim();
    if (toolName.length === 0 || !/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(toolName)) {
      continue;
    }

    const input: JsonObject = {};
    for (const { key, value } of extractArgPairs(body)) {
      if (key.length === 0) {
        continue;
      }
      input[key] = parseArgValue(value);
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

/**
 * Distinguish a response that *is* a tool call expressed as markup from prose
 * that merely documents or quotes the markup. Only the former should be
 * executed; otherwise an assistant explaining the `<tool_call>` format would
 * silently trigger real tool calls and lose its visible answer.
 */
export function isPrimarilyTextToolCallMarkup(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || !trimmed.toLowerCase().includes(TOOL_CALL_OPEN)) {
    return false;
  }
  const residual = removeBlocks(trimmed, TOOL_CALL_OPEN, TOOL_CALL_CLOSE)
    .replace(/\s+/gu, " ")
    .trim();
  return residual.length <= 40;
}

function extractBlocks(source: string, openTag: string, closeTag: string): string[] {
  return findBlockRanges(source, openTag, closeTag).map((range) =>
    source.slice(range.contentStart, range.closeAt)
  );
}

function removeBlocks(source: string, openTag: string, closeTag: string): string {
  const ranges = findBlockRanges(source, openTag, closeTag);
  if (ranges.length === 0) {
    return source;
  }
  let residual = "";
  let cursor = 0;
  for (const range of ranges) {
    residual += source.slice(cursor, range.openAt);
    residual += " ";
    cursor = range.closeAt + closeTag.length;
  }
  residual += source.slice(cursor);
  return residual;
}

function findBlockRanges(
  source: string,
  openTag: string,
  closeTag: string
): Array<{ closeAt: number; contentStart: number; openAt: number }> {
  const ranges: Array<{ closeAt: number; contentStart: number; openAt: number }> = [];
  const lower = source.toLowerCase();
  const openLower = openTag.toLowerCase();
  const closeLower = closeTag.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const openAt = lower.indexOf(openLower, searchFrom);
    if (openAt === -1) {
      break;
    }
    const contentStart = openAt + openTag.length;
    const nextOpenAt = lower.indexOf(openLower, contentStart);
    const searchEnd = nextOpenAt === -1 ? source.length : nextOpenAt;
    const closeAt = lower.lastIndexOf(closeLower, searchEnd - 1);
    if (closeAt < contentStart) {
      searchFrom = contentStart;
      continue;
    }
    ranges.push({ closeAt, contentStart, openAt });
    searchFrom = closeAt + closeTag.length;
  }
  return ranges;
}

function extractArgPairs(body: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const lower = body.toLowerCase();
  let searchFrom = 0;
  while (searchFrom < body.length) {
    const keyOpenAt = lower.indexOf(ARG_KEY_OPEN, searchFrom);
    if (keyOpenAt === -1) {
      break;
    }
    const keyStart = keyOpenAt + ARG_KEY_OPEN.length;
    const keyCloseAt = lower.indexOf(ARG_KEY_CLOSE, keyStart);
    if (keyCloseAt === -1) {
      break;
    }
    const key = body.slice(keyStart, keyCloseAt).trim();
    const afterKey = keyCloseAt + ARG_KEY_CLOSE.length;
    const valueOpenAt = lower.indexOf(ARG_VALUE_OPEN, afterKey);
    if (valueOpenAt === -1) {
      searchFrom = afterKey;
      continue;
    }
    const valueStart = valueOpenAt + ARG_VALUE_OPEN.length;
    const nextKeyOpenAt = lower.indexOf(ARG_KEY_OPEN, valueStart);
    const toolCloseAt = lower.indexOf(TOOL_CALL_CLOSE, valueStart);
    const searchEndCandidates = [body.length];
    if (nextKeyOpenAt !== -1) {
      searchEndCandidates.push(nextKeyOpenAt);
    }
    if (toolCloseAt !== -1) {
      searchEndCandidates.push(toolCloseAt);
    }
    const searchEnd = Math.min(...searchEndCandidates);
    const valueCloseAt = lower.lastIndexOf(ARG_VALUE_CLOSE, searchEnd - 1);
    if (valueCloseAt < valueStart) {
      searchFrom = valueStart;
      continue;
    }
    pairs.push({ key, value: body.slice(valueStart, valueCloseAt) });
    searchFrom = valueCloseAt + ARG_VALUE_CLOSE.length;
  }
  return pairs;
}

function parseArgValue(rawValue: string): JsonObject[string] {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "";
  }
  // Only unwrap JSON that resolves to a string (e.g. `"update_file"`). Objects,
  // arrays, numbers, and booleans are kept as the raw string so tools with
  // string-typed fields (such as `write_file.content`) are not silently coerced
  // into a non-string value that fails schema validation.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Not JSON; fall back to the raw string below.
  }
  return rawValue;
}
