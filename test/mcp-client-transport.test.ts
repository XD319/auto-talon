import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { McpStdioTransport, formatMalformedJsonRpcError } from "../src/mcp/index.js";

describe("McpStdioTransport", () => {
  it("lists tools and invokes tool calls through stdio json-rpc", async () => {
    const serverScript = resolve(process.cwd(), "test", "fixtures", "mcp-fake-server.js");
    const transport = new McpStdioTransport({
      args: [serverScript],
      command: process.execPath,
      env: {},
      id: "fake",
      privacyLevel: "internal",
      riskLevel: "high"
    });

    const tools = await transport.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("echo");

    const result = await transport.callTool({
      input: { text: "hello" },
      toolName: "echo"
    });
    expect(result.content).toEqual({
      echoed: {
        text: "hello"
      }
    });
  });

  it("rejects pending requests when the server returns malformed JSON", async () => {
    const serverScript = resolve(process.cwd(), "test", "fixtures", "mcp-bad-json-server.js");
    const transport = new McpStdioTransport({
      args: [serverScript],
      command: process.execPath,
      env: {},
      id: "bad-json",
      privacyLevel: "internal",
      riskLevel: "high"
    });

    await expect(transport.listTools()).rejects.toMatchObject({
      code: "tool_execution_error",
      message: formatMalformedJsonRpcError("bad-json", "{not valid json")
    });
  });
});
