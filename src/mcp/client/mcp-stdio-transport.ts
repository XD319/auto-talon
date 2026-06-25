import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";

import { AppError } from "../../core/app-error.js";
import { buildChildEnv } from "../../tools/shell/shell-executor.js";
import type {
  McpClientHandle,
  McpInvocationContext,
  McpPromptDescriptor,
  McpPromptGetRequest,
  McpPromptGetResult,
  McpResourceDescriptor,
  McpResourceReadRequest,
  McpResourceReadResult,
  McpServerConfig,
  McpToolCallRequest,
  McpToolCallResult,
  McpToolDescriptor
} from "../../types/index.js";
import {
  asObject,
  asString,
  formatMalformedJsonRpcError,
  jsonRpcError,
  normalizeContent,
  parseJsonRpcLines,
  parsePrompts,
  parseResources,
  parseTools,
  startupTimeoutMs,
  toolTimeoutMs,
  truncateJsonRpcLine,
  type JsonRpcMessage
} from "./mcp-protocol.js";

interface PendingRequest {
  method: string;
  reject: (error: AppError) => void;
  resolve: (message: JsonRpcMessage) => void;
  timeout: NodeJS.Timeout;
}

export class McpStdioTransport implements McpClientHandle {
  public readonly serverId: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private initialized = false;
  private instructions = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private readline: Interface | null = null;

  public constructor(private readonly config: McpServerConfig) {
    this.serverId = config.id;
  }

  public async initialize(): Promise<{ instructions: string }> {
    if (this.initialized) {
      return { instructions: this.instructions };
    }
    this.start();
    const response = await this.request("initialize", {
      clientInfo: {
        name: "auto-talon",
        version: "phase5"
      },
      protocolVersion: "2024-11-05"
    }, startupTimeoutMs(this.config));
    const payload = asObject(response.result);
    this.instructions = asString(payload.instructions, "");
    this.initialized = true;
    return { instructions: this.instructions };
  }

  public listTools(): Promise<McpToolDescriptor[]> {
    return this.initialize()
      .then(() => this.request("tools/list", {}, startupTimeoutMs(this.config)))
      .then((response) => parseTools(this.serverId, response.result, this.config));
  }

  public listToolsSync(): McpToolDescriptor[] {
    return parseTools(this.serverId, this.requestSync("tools/list", {}).result, this.config);
  }

  public listResources(): Promise<McpResourceDescriptor[]> {
    return this.initialize()
      .then(() => this.request("resources/list", {}, startupTimeoutMs(this.config)))
      .then((response) => parseResources(this.serverId, response.result));
  }

  public readResource(
    request: McpResourceReadRequest,
    context?: McpInvocationContext
  ): Promise<McpResourceReadResult> {
    return this.requestWithAbort("resources/read", { uri: request.uri }, context).then((response) => ({
      content: normalizeContent(response.result)
    }));
  }

  public listPrompts(): Promise<McpPromptDescriptor[]> {
    return this.initialize()
      .then(() => this.request("prompts/list", {}, startupTimeoutMs(this.config)))
      .then((response) => parsePrompts(this.serverId, response.result));
  }

  public getPrompt(
    request: McpPromptGetRequest,
    context?: McpInvocationContext
  ): Promise<McpPromptGetResult> {
    return this.requestWithAbort(
      "prompts/get",
      {
        arguments: request.arguments ?? {},
        name: request.promptName
      },
      context
    ).then((response) => ({
      content: normalizeContent(response.result)
    }));
  }

  public callTool(
    request: McpToolCallRequest,
    context?: McpInvocationContext
  ): Promise<McpToolCallResult> {
    return this.requestWithAbort(
      "tools/call",
      {
        arguments: request.input,
        name: request.toolName
      },
      context
    ).then((response) => {
      const payload = asObject(response.result);
      return {
        content: (payload.content ?? payload) as McpToolCallResult["content"]
      };
    });
  }

  public ping(): Promise<void> {
    return this.listTools().then(() => undefined);
  }

  public pingSync(): void {
    this.listToolsSync();
  }

  public close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(
        new AppError({
          code: "interrupt",
          message: `MCP server ${this.serverId} was closed.`
        })
      );
    }
    this.pending.clear();
    this.readline?.close();
    this.readline = null;
    if (this.child !== null) {
      this.child.kill();
      this.child = null;
    }
    this.initialized = false;
    return Promise.resolve();
  }

  private async requestWithAbort(
    method: string,
    params: Record<string, unknown>,
    context?: McpInvocationContext
  ): Promise<JsonRpcMessage> {
    if (context?.signal?.aborted === true) {
      throw new AppError({
        code: "interrupt",
        message: `MCP ${this.serverId}/${method} aborted before start.`
      });
    }
    await this.initialize();
    const promise = this.request(method, params, toolTimeoutMs(this.config));
    if (context?.signal === undefined) {
      return promise;
    }
    const signal = context.signal;
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const onAbort = (): void => {
        reject(
          new AppError({
            code: "interrupt",
            message: `MCP ${this.serverId}/${method} aborted.`
          })
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  private start(): void {
    if (this.child !== null) {
      return;
    }
    if (this.config.command === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        message: `MCP server ${this.serverId} is missing stdio command.`
      });
    }
    this.child = spawn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: buildChildEnv(process.env, this.config.env ?? {}),
      stdio: "pipe"
    });
    this.child.on("error", (error) => this.failAll(`Failed to run MCP server ${this.serverId}.`, error));
    this.child.on("close", (code) => {
      this.failAll(`MCP server ${this.serverId} exited with status ${code ?? "unknown"}.`);
      this.child = null;
      this.initialized = false;
    });
    this.readline = createInterface({
      input: this.child.stdout,
      terminal: false
    });
    this.readline.on("line", (line) => this.handleLine(line));
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<JsonRpcMessage> {
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const child = this.child;
      if (child === null) {
        reject(
          new AppError({
            code: "tool_execution_error",
            message: `MCP server ${this.serverId} is not started.`
          })
        );
        return;
      }
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError({
            code: "tool_execution_error",
            details: { method, serverId: this.serverId },
            message: `MCP ${this.serverId}/${method} timed out.`
          })
        );
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timeout });
      child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`, "utf8");
    });
  }

  private requestSync(method: string, params: Record<string, unknown>): JsonRpcMessage {
    if (this.config.command === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        message: `MCP server ${this.serverId} is missing stdio command.`
      });
    }
    const requests = [
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          clientInfo: { name: "auto-talon", version: "phase5" },
          protocolVersion: "2024-11-05"
        }
      },
      {
        id: 2,
        jsonrpc: "2.0",
        method,
        params
      }
    ];
    const output = spawnSync(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      encoding: "utf8",
      env: buildChildEnv(process.env, this.config.env ?? {}),
      input: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`,
      timeout: startupTimeoutMs(this.config)
    });
    if (output.error !== undefined) {
      throw new AppError({
        cause: output.error,
        code: "tool_execution_error",
        details: { serverId: this.serverId },
        message: `Failed to run MCP server ${this.serverId}.`
      });
    }
    if (output.status !== 0) {
      throw new AppError({
        code: "tool_execution_error",
        details: {
          exitCode: output.status,
          serverId: this.serverId,
          stderr: output.stderr
        },
        message: `MCP server ${this.serverId} exited with status ${output.status}.`
      });
    }
    const response = parseJsonRpcLines(output.stdout).find((message) => message.id === 2);
    if (response === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        details: { serverId: this.serverId, stdout: output.stdout },
        message: `MCP server ${this.serverId} returned no response for ${method}.`
      });
    }
    if (response.error !== undefined) {
      throw jsonRpcError(this.serverId, method, response.error);
    }
    return response;
  }

  private handleLine(line: string): void {
    const text = line.trim();
    if (text.length === 0) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(text) as JsonRpcMessage;
    } catch {
      if (this.pending.size > 0) {
        this.failAll(formatMalformedJsonRpcError(this.serverId, text));
      } else {
        console.warn(`MCP ${this.serverId} ignored malformed JSON line: ${truncateJsonRpcLine(text)}`);
      }
      return;
    }
    if (message.id === undefined) {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error !== undefined) {
      pending.reject(jsonRpcError(this.serverId, pending.method, message.error));
      return;
    }
    pending.resolve(message);
  }

  private failAll(message: string, cause?: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(
        new AppError({
          cause,
          code: "tool_execution_error",
          details: { serverId: this.serverId },
          message
        })
      );
      this.pending.delete(id);
    }
  }
}

export {
  formatMalformedJsonRpcError,
  normalizeContent,
  parsePrompts,
  parseResources,
  parseTools
} from "./mcp-protocol.js";
