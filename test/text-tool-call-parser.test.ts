import { describe, expect, it } from "vitest";

import {
  contentLooksLikeTextToolCallMarkup,
  isPrimarilyTextToolCallMarkup,
  parseTextToolCalls
} from "../src/providers/text-tool-call-parser.js";

describe("parseTextToolCalls", () => {
  it("parses xfyun-style tool_call markup into structured tool calls", () => {
    const content =
      "<tool_call>write_file<arg_key>content</arg_key><arg_value>export const ok = true;\n</arg_value><arg_key>path</arg_key><arg_value>verify.mjs</arg_value></tool_call>";
    const toolCalls = parseTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.toolName).toBe("write_file");
    expect(toolCalls[0]?.input).toEqual({
      content: "export const ok = true;\n",
      path: "verify.mjs"
    });
    expect(toolCalls[0]?.toolCallId.startsWith("text-call_")).toBe(true);
    expect(toolCalls[0]?.raw).toMatchObject({ source: "text_tool_call_markup" });
  });

  it("parses JSON arg values when possible", () => {
    const content =
      '<tool_call>patch<arg_key>action</arg_key><arg_value>"update_file"</arg_value><arg_key>path</arg_key><arg_value>"src/a.ts"</arg_value></tool_call>';
    const toolCalls = parseTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.input).toEqual({
      action: "update_file",
      path: "src/a.ts"
    });
  });

  it("parses multiple tool_call blocks", () => {
    const content = [
      "<tool_call>read_file<arg_key>path</arg_key><arg_value>a.txt</arg_value></tool_call>",
      "<tool_call>read_file<arg_key>path</arg_key><arg_value>b.txt</arg_value></tool_call>"
    ].join("\n");
    const toolCalls = parseTextToolCalls(content);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((call) => call.input.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("keeps nested closing tags inside arg values by matching the last closer", () => {
    const content =
      "<tool_call>write_file" +
      "<arg_key>path</arg_key><arg_value>demo.txt</arg_value>" +
      "<arg_key>content</arg_key><arg_value>before</arg_value>after</arg_value>" +
      "</tool_call>";
    const toolCalls = parseTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.input).toEqual({
      content: "before</arg_value>after",
      path: "demo.txt"
    });
  });

  it("keeps JSON object, number, and boolean arg values as strings", () => {
    const content =
      "<tool_call>write_file" +
      "<arg_key>path</arg_key><arg_value>config.json</arg_value>" +
      '<arg_key>content</arg_key><arg_value>{"a":1}</arg_value>' +
      "<arg_key>count</arg_key><arg_value>42</arg_value>" +
      "<arg_key>flag</arg_key><arg_value>true</arg_value>" +
      "</tool_call>";
    const toolCalls = parseTextToolCalls(content);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.input).toEqual({
      content: '{"a":1}',
      count: "42",
      flag: "true",
      path: "config.json"
    });
    expect(typeof toolCalls[0]?.input.content).toBe("string");
  });

  it("returns empty for ordinary final answers", () => {
    expect(parseTextToolCalls("Implementation complete and verified.")).toEqual([]);
  });
});

describe("contentLooksLikeTextToolCallMarkup", () => {
  it("detects tool_call and arg tags", () => {
    expect(contentLooksLikeTextToolCallMarkup("<tool_call>write_file</tool_call>")).toBe(true);
    expect(contentLooksLikeTextToolCallMarkup("<arg_key>path</arg_key>")).toBe(true);
    expect(contentLooksLikeTextToolCallMarkup("plain answer")).toBe(false);
  });
});

describe("isPrimarilyTextToolCallMarkup", () => {
  it("treats a response that is only tool_call markup as executable", () => {
    const content =
      "<tool_call>write_file<arg_key>path</arg_key><arg_value>verify.mjs</arg_value></tool_call>";
    expect(isPrimarilyTextToolCallMarkup(content)).toBe(true);
  });

  it("allows a short lead-in before the markup", () => {
    const content =
      "OK:\n<tool_call>read_file<arg_key>path</arg_key><arg_value>a.txt</arg_value></tool_call>";
    expect(isPrimarilyTextToolCallMarkup(content)).toBe(true);
  });

  it("does not treat prose that documents the markup as executable", () => {
    const content =
      "To write a file you call the tool with markup like this: " +
      "<tool_call>write_file<arg_key>path</arg_key><arg_value>example.txt</arg_value></tool_call>. " +
      "This is only an example and should not actually run the tool for you.";
    expect(isPrimarilyTextToolCallMarkup(content)).toBe(false);
    // Ordinary prose without markup is never executable either.
    expect(isPrimarilyTextToolCallMarkup("Here is my final answer.")).toBe(false);
  });
});
