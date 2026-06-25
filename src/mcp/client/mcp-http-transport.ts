import { AppError } from "../../core/app-error.js";
import type {
  JsonObject,
  JsonValue,
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
  jsonRpcError,
  normalizeContent,
  parsePrompts,
  parseResources,
  parseTools,
  startupTimeoutMs,
  toolTimeoutMs,
  type JsonRpcMessage
} from "./mcp-protocol.js";

export class McpHttpTransport implements McpClientHandle {
  public readonly serverId: string;
  private initialized = false;
  private instructions = "";
  private nextId = 1;

  public constructor(private readonly config: McpServerConfig) {
    this.serverId = config.id;
  }

  public async initialize(): Promise<{ instructions: string }> {
    if (this.initialized) {
      return { instructions: this.instructions };
    }
    const response = await this.request("initialize", {
      clientInfo: {
        name: "auto-talon",
        version: "phase5"
      },
      protocolVersion: "2024-11-05"
    }, startupTimeoutMs(this.config));
    const result = asObject(response.result);
    this.instructions = typeof result.instructions === "string" ? result.instructions : "";
    this.initialized = true;
    return { instructions: this.instructions };
  }

  public listTools(): Promise<McpToolDescriptor[]> {
    return this.initialize()
      .then(() => this.request("tools/list", {}, startupTimeoutMs(this.config)))
      .then((response) => parseTools(this.serverId, response.result, this.config));
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
    return this.requestWithContext("resources/read", { uri: request.uri }, context).then((response) => ({
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
    return this.requestWithContext(
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
    return this.requestWithContext(
      "tools/call",
      {
        arguments: request.input,
        name: request.toolName
      },
      context
    ).then((response) => {
      const result = asObject(response.result);
      return {
        content: (result.content ?? result) as JsonValue
      };
    });
  }

  public ping(): Promise<void> {
    return this.listTools().then(() => undefined);
  }

  public close(): Promise<void> {
    this.initialized = false;
    return Promise.resolve();
  }

  private async requestWithContext(
    method: string,
    params: JsonObject,
    context?: McpInvocationContext
  ): Promise<JsonRpcMessage> {
    if (context?.signal?.aborted === true) {
      throw new AppError({
        code: "interrupt",
        message: `MCP ${this.serverId}/${method} aborted before start.`
      });
    }
    await this.initialize();
    return this.request(method, params, toolTimeoutMs(this.config), context?.signal);
  }

  private async request(
    method: string,
    params: JsonObject,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<JsonRpcMessage> {
    if (this.config.url === undefined) {
      throw new AppError({
        code: "tool_execution_error",
        message: `MCP server ${this.serverId} is missing streamable_http url.`
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(this.config.url, {
        body: JSON.stringify({
          id: this.nextId++,
          jsonrpc: "2.0",
          method,
          params
        }),
        headers: this.resolveHeaders(),
        method: "POST",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new AppError({
          code: "tool_execution_error",
          details: {
            serverId: this.serverId,
            status: response.status
          },
          message: `MCP ${this.serverId}/${method} HTTP ${response.status}.`
        });
      }
      const payload = (await response.json()) as JsonRpcMessage;
      if (payload.error !== undefined) {
        throw jsonRpcError(this.serverId, method, payload.error);
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError({
        cause: error,
        code: controller.signal.aborted ? "interrupt" : "tool_execution_error",
        details: {
          method,
          serverId: this.serverId
        },
        message: controller.signal.aborted
          ? `MCP ${this.serverId}/${method} aborted or timed out.`
          : `MCP ${this.serverId}/${method} request failed.`
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private resolveHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(this.config.headers ?? {})
    };
    for (const [header, envName] of Object.entries(this.config.envHeaders ?? {})) {
      const value = process.env[envName];
      if (value !== undefined && value.length > 0) {
        headers[header] = value;
      }
    }
    if (this.config.bearerTokenEnvVar !== undefined) {
      const token = process.env[this.config.bearerTokenEnvVar];
      if (token !== undefined && token.length > 0) {
        headers.authorization = `Bearer ${token}`;
      }
    }
    return headers;
  }
}
