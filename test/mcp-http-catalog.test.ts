import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { McpClientManager } from "../src/mcp/index.js";
import { ToolRegistry } from "../src/tools/index.js";

describe("MCP HTTP catalog", () => {
  it("searches streamable HTTP tools and reads resources/prompts", async () => {
    const server = createServer(handleMcpRequest);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP test server.");
    }
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-mcp-http-"));
    try {
      mkdirSync(join(workspace, ".auto-talon"), { recursive: true });
      writeFileSync(
        join(workspace, ".auto-talon", "mcp.config.json"),
        `${JSON.stringify({
          servers: [
            {
              alwaysLoad: false,
              id: "httpfake",
              type: "streamable_http",
              url: `http://127.0.0.1:${address.port}/mcp`
            }
          ]
        })}\n`,
        "utf8"
      );
      const manager = new McpClientManager(workspace);
      expect(manager.discover()).toHaveLength(0);

      const registry = new ToolRegistry();
      const searchTool = manager.createCatalogTools((tool) => {
        if (!registry.has(tool.name)) {
          registry.register(tool);
        }
      })[0];
      if (searchTool === undefined) {
        throw new Error("Expected search tool.");
      }
      const search = await searchTool.execute(
        searchTool.prepare({ query: "echo" }, createContext()).preparedInput,
        createContext()
      );
      expect(search.success).toBe(true);
      expect(registry.has("mcp__httpfake__echo")).toBe(true);

      const resource = await manager.readResource("doc://intro");
      expect(JSON.stringify(resource)).toContain("resource body");

      const prompt = await manager.getPrompt("httpfake", "summarize", { topic: "mcp" });
      expect(JSON.stringify(prompt)).toContain("summarize mcp");
    } finally {
      rmSync(workspace, { force: true, recursive: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function createContext() {
  return {
    agentProfileId: "executor" as const,
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "task-1",
    userId: "local-user",
    workspaceRoot: process.cwd()
  };
}

function handleMcpRequest(request: IncomingMessage, response: ServerResponse): void {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const message = parseJsonRpcRequest(body);
    response.setHeader("content-type", "application/json");
    if (message.method === "initialize") {
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            instructions: "Use fake server carefully.",
            serverInfo: { name: "httpfake", version: "1.0.0" }
          }
        })
      );
      return;
    }
    if (message.method === "tools/list") {
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              {
                description: "Echo payload",
                inputSchema: { properties: { text: { type: "string" } }, type: "object" },
                name: "echo"
              }
            ]
          }
        })
      );
      return;
    }
    if (message.method === "resources/list") {
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            resources: [{ description: "Intro", name: "intro", uri: "doc://intro" }]
          }
        })
      );
      return;
    }
    if (message.method === "resources/read") {
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: { contents: [{ text: "resource body", uri: message.params?.uri }] }
        })
      );
      return;
    }
    if (message.method === "prompts/list") {
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            prompts: [{ arguments: [{ name: "topic" }], description: "Summarize", name: "summarize" }]
          }
        })
      );
      return;
    }
    if (message.method === "prompts/get") {
      const args = message.params?.arguments as { topic?: string } | undefined;
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: { messages: [{ content: `summarize ${args?.topic ?? ""}`, role: "user" }] }
        })
      );
      return;
    }
    response.end(JSON.stringify({ error: { code: -32601, message: "not found" }, id: message.id, jsonrpc: "2.0" }));
  });
}

function parseJsonRpcRequest(body: string): { id: number; method: string; params?: Record<string, unknown> } {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON-RPC request object.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.id !== "number" || typeof record.method !== "string") {
    throw new Error("Expected JSON-RPC id and method.");
  }
  const params = record.params;
  return {
    id: record.id,
    method: record.method,
    ...(typeof params === "object" && params !== null && !Array.isArray(params)
      ? { params: params as Record<string, unknown> }
      : {})
  };
}
