import type { JsonObject, JsonValue } from "./common.js";
import type { PrivacyLevel, ToolRiskLevel } from "./governance.js";

export interface McpServerConfig {
  id: string;
  type?: "stdio" | "streamable_http";
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
  headers?: Record<string, string>;
  envHeaders?: Record<string, string>;
  bearerTokenEnvVar?: string;
  cwd?: string;
  enabled?: boolean;
  required?: boolean;
  alwaysLoad?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  riskLevel: ToolRiskLevel;
  privacyLevel: PrivacyLevel;
}

export interface McpConfigFile {
  servers: McpServerConfig[];
}

export interface McpToolDescriptor {
  serverId: string;
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface McpResourceDescriptor {
  serverId: string;
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface McpPromptDescriptor {
  serverId: string;
  name: string;
  description: string;
  arguments: JsonValue;
}

export interface McpPromptGetRequest {
  promptName: string;
  arguments?: JsonObject;
}

export interface McpPromptGetResult {
  content: JsonValue;
}

export interface McpResourceReadRequest {
  uri: string;
}

export interface McpResourceReadResult {
  content: JsonValue;
}

export interface McpServerCatalog {
  serverId: string;
  instructions: string;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  prompts: McpPromptDescriptor[];
  discoveryError: string | null;
}

export interface McpInvocationContext {
  signal?: AbortSignal;
}

export interface McpToolCallRequest {
  toolName: string;
  input: JsonObject;
}

export interface McpToolCallResult {
  content: JsonValue;
}

export interface McpClientHandle {
  serverId: string;
  initialize(): Promise<{ instructions: string }>;
  listTools(): Promise<McpToolDescriptor[]>;
  listResources(): Promise<McpResourceDescriptor[]>;
  readResource(
    request: McpResourceReadRequest,
    context?: McpInvocationContext
  ): Promise<McpResourceReadResult>;
  listPrompts(): Promise<McpPromptDescriptor[]>;
  getPrompt(
    request: McpPromptGetRequest,
    context?: McpInvocationContext
  ): Promise<McpPromptGetResult>;
  callTool(
    request: McpToolCallRequest,
    context?: McpInvocationContext
  ): Promise<McpToolCallResult>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
