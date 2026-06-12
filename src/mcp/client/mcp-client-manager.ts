import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { McpHttpTransport } from "./mcp-http-transport.js";
import { McpStdioTransport } from "./mcp-stdio-transport.js";
import { McpToolAdapter } from "./mcp-tool-adapter.js";
import { McpPromptTool, McpResourceTool, McpToolSearchTool } from "./mcp-catalog-tools.js";
import type {
  JsonObject,
  JsonValue,
  McpClientHandle,
  McpConfigFile,
  McpPromptDescriptor,
  McpResourceDescriptor,
  McpServerCatalog,
  McpServerConfig,
  McpToolDescriptor,
  ToolDefinition
} from "../../types/index.js";

export interface McpToolSearchResult {
  catalog: McpServerCatalog[];
  matches: Array<McpToolDescriptor & { callableToolName: string; materialized: boolean }>;
}

export class McpClientManager {
  private readonly configPath: string;
  private readonly catalogs = new Map<string, McpServerCatalog>();
  private readonly handles = new Map<string, McpClientHandle>();
  private readonly materializedTools = new Map<string, ToolDefinition>();
  private readonly serverConfigs = new Map<string, McpServerConfig>();

  public constructor(workspaceRoot: string) {
    this.configPath = join(workspaceRoot, ".auto-talon", "mcp.config.json");
  }

  public discover(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.readConfig().servers) {
      if (server.enabled === false) {
        continue;
      }
      const handle = createHandle(server);
      this.handles.set(server.id, handle);
      this.serverConfigs.set(server.id, server);
      const catalog = emptyCatalog(server.id);
      try {
        if (handle instanceof McpStdioTransport) {
          catalog.tools = handle.listToolsSync();
          if (server.alwaysLoad === true) {
            for (const descriptor of catalog.tools) {
              const adapter = this.createToolAdapter(descriptor, server, handle);
              tools.push(adapter);
            }
          }
        }
      } catch (error) {
        catalog.discoveryError = error instanceof Error ? error.message : String(error);
        if (server.required) {
          throw error;
        }
      }
      this.catalogs.set(server.id, catalog);
    }
    return tools;
  }

  public createCatalogTools(registerTool: (tool: ToolDefinition) => void): ToolDefinition[] {
    return [
      new McpToolSearchTool(this, registerTool),
      new McpResourceTool(this),
      new McpPromptTool(this)
    ];
  }

  public async listServers(): Promise<
    Array<{
      id: string;
      type: "stdio" | "streamable_http";
      toolCount: number;
      resourceCount: number;
      promptCount: number;
      instructions: string;
      tools: string[];
      discoveryError: string | null;
    }>
  > {
    await this.refreshAllCatalogs();
    return [...this.serverConfigs.values()].map((server) => {
      const catalog = this.catalogs.get(server.id) ?? emptyCatalog(server.id);
      return {
        discoveryError: catalog.discoveryError,
        id: server.id,
        instructions: catalog.instructions,
        promptCount: catalog.prompts.length,
        resourceCount: catalog.resources.length,
        toolCount: catalog.tools.length,
        tools: catalog.tools.map((tool) => tool.name),
        type: server.type ?? "stdio"
      };
    });
  }

  public async ping(serverId: string): Promise<void> {
    const handle = this.handles.get(serverId);
    if (handle === undefined) {
      throw new Error(`MCP server ${serverId} is not configured.`);
    }
    await handle.ping();
  }

  public async searchTools(query: string, limit = 8): Promise<McpToolSearchResult> {
    await this.refreshAllCatalogs();
    const normalizedQuery = query.toLowerCase().trim();
    const matches = [...this.catalogs.values()]
      .flatMap((catalog) => catalog.tools)
      .map((tool) => ({
        ...tool,
        score: scoreTool(tool, normalizedQuery)
      }))
      .filter((tool) => normalizedQuery.length === 0 || tool.score > 0)
      .sort((left, right) => right.score - left.score || left.serverId.localeCompare(right.serverId) || left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((tool) => {
        const toolName = toRuntimeToolName(tool);
        return {
          callableToolName: toolName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          materialized: this.materializedTools.has(toolName),
          name: tool.name,
          serverId: tool.serverId
        };
      });
    return {
      catalog: [...this.catalogs.values()],
      matches
    };
  }

  public materializeTool(runtimeToolName: string): ToolDefinition | null {
    const existing = this.materializedTools.get(runtimeToolName);
    if (existing !== undefined) {
      return existing;
    }
    const parsed = parseRuntimeToolName(runtimeToolName);
    if (parsed === null) {
      return null;
    }
    const catalog = this.catalogs.get(parsed.serverId);
    const config = this.serverConfigs.get(parsed.serverId);
    const handle = this.handles.get(parsed.serverId);
    const descriptor = catalog?.tools.find((tool) => tool.name === parsed.toolName);
    if (config === undefined || handle === undefined || descriptor === undefined) {
      return null;
    }
    return this.createToolAdapter(descriptor, config, handle);
  }

  public async readResource(uri: string, context?: { signal?: AbortSignal }): Promise<JsonValue> {
    await this.refreshAllCatalogs();
    const resource = this.findResource(uri);
    if (resource === null) {
      throw new Error(`MCP resource not found: ${uri}`);
    }
    const handle = this.handles.get(resource.serverId);
    if (handle === undefined) {
      throw new Error(`MCP server ${resource.serverId} is not configured.`);
    }
    const result = await handle.readResource({ uri: resource.uri }, context);
    return limitMcpOutput(result.content);
  }

  public async getPrompt(
    serverId: string,
    promptName: string,
    args: JsonObject,
    context?: { signal?: AbortSignal }
  ): Promise<JsonValue> {
    await this.refreshServerCatalog(serverId);
    const prompt = this.catalogs.get(serverId)?.prompts.find((entry) => entry.name === promptName);
    if (prompt === undefined) {
      throw new Error(`MCP prompt not found: ${serverId}/${promptName}`);
    }
    const handle = this.handles.get(serverId);
    if (handle === undefined) {
      throw new Error(`MCP server ${serverId} is not configured.`);
    }
    const result = await handle.getPrompt({ arguments: args, promptName }, context);
    return limitMcpOutput(result.content);
  }

  public listResourceMetadata(): McpResourceDescriptor[] {
    return [...this.catalogs.values()].flatMap((catalog) => catalog.resources);
  }

  public listPromptMetadata(): McpPromptDescriptor[] {
    return [...this.catalogs.values()].flatMap((catalog) => catalog.prompts);
  }

  public async close(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.close();
    }
    this.catalogs.clear();
    this.handles.clear();
    this.materializedTools.clear();
    this.serverConfigs.clear();
  }

  private createToolAdapter(
    descriptor: McpToolDescriptor,
    config: McpServerConfig,
    handle: McpClientHandle
  ): ToolDefinition {
    const adapter = new McpToolAdapter(descriptor, config, handle);
    this.materializedTools.set(adapter.name, adapter);
    return adapter;
  }

  private async refreshAllCatalogs(): Promise<void> {
    await Promise.all([...this.serverConfigs.keys()].map((serverId) => this.refreshServerCatalog(serverId)));
  }

  private async refreshServerCatalog(serverId: string): Promise<void> {
    const handle = this.handles.get(serverId);
    const config = this.serverConfigs.get(serverId);
    if (handle === undefined || config === undefined) {
      return;
    }
    const catalog = this.catalogs.get(serverId) ?? emptyCatalog(serverId);
    try {
      const init = await handle.initialize();
      const [tools, resources, prompts] = await Promise.all([
        handle.listTools().catch(() => catalog.tools),
        handle.listResources().catch(() => catalog.resources),
        handle.listPrompts().catch(() => catalog.prompts)
      ]);
      this.catalogs.set(serverId, {
        discoveryError: null,
        instructions: init.instructions,
        prompts,
        resources,
        serverId,
        tools
      });
    } catch (error) {
      this.catalogs.set(serverId, {
        ...catalog,
        discoveryError: error instanceof Error ? error.message : String(error)
      });
      if (config.required === true) {
        throw error;
      }
    }
  }

  private findResource(uri: string): McpResourceDescriptor | null {
    const resources = this.listResourceMetadata();
    const direct = resources.find((resource) => resource.uri === uri);
    if (direct !== undefined) {
      return direct;
    }
    const byServerUri = resources.find((resource) => `${resource.serverId}:${resource.uri}` === uri);
    return byServerUri ?? null;
  }

  private readConfig(): McpConfigFile {
    const pluginServers = this.readPluginServerConfigs();
    if (!existsSync(this.configPath)) {
      return { servers: pluginServers };
    }
    const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as { servers?: unknown[] };
    if (!Array.isArray(parsed.servers)) {
      return { servers: pluginServers };
    }
    return {
      servers: [
        ...parsed.servers
        .filter((server): server is Partial<McpServerConfig> & { id: string } => {
          return typeof server === "object" && server !== null && typeof (server as { id?: unknown }).id === "string";
        })
        .map(normalizeServerConfig)
        .filter((server) => server !== null),
        ...pluginServers
      ]
    };
  }

  private readPluginServerConfigs(): McpServerConfig[] {
    const pluginsRoot = join(this.configPath, "..", "plugins");
    if (!existsSync(pluginsRoot)) {
      return [];
    }
    return readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const manifestPath = join(pluginsRoot, entry.name, ".codex-plugin", "plugin.json");
        if (!existsSync(manifestPath)) {
          return [];
        }
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          mcpServers?: Array<Partial<McpServerConfig> & { id?: string }>;
        };
        return (parsed.mcpServers ?? [])
          .filter((server): server is Partial<McpServerConfig> & { id: string } => typeof server.id === "string")
          .map((server) =>
            normalizeServerConfig({
              ...server,
              id: `${entry.name}_${server.id}`
            })
          )
          .filter((server) => server !== null);
      });
  }
}

function createHandle(server: McpServerConfig): McpClientHandle {
  if (server.type === "streamable_http") {
    return new McpHttpTransport(server);
  }
  return new McpStdioTransport(server);
}

function normalizeServerConfig(server: Partial<McpServerConfig> & { id: string }): McpServerConfig | null {
  const type = server.type ?? (typeof server.url === "string" ? "streamable_http" : "stdio");
  if (type === "stdio" && typeof server.command !== "string") {
    return null;
  }
  if (type === "streamable_http" && typeof server.url !== "string") {
    return null;
  }
  const normalized: McpServerConfig = {
    alwaysLoad: server.alwaysLoad ?? true,
    args: Array.isArray(server.args) ? server.args : [],
    disabledTools: Array.isArray(server.disabledTools) ? server.disabledTools : [],
    enabled: server.enabled ?? true,
    enabledTools: Array.isArray(server.enabledTools) ? server.enabledTools : [],
    env: server.env ?? {},
    envHeaders: server.envHeaders ?? {},
    headers: server.headers ?? {},
    id: server.id,
    privacyLevel: server.privacyLevel ?? "internal",
    required: server.required ?? false,
    riskLevel: server.riskLevel ?? "high",
    startupTimeoutMs: server.startupTimeoutMs ?? 10_000,
    toolTimeoutMs: server.toolTimeoutMs ?? 60_000,
    type
  };
  if (server.bearerTokenEnvVar !== undefined) {
    normalized.bearerTokenEnvVar = server.bearerTokenEnvVar;
  }
  if (server.command !== undefined) {
    normalized.command = server.command;
  }
  if (server.cwd !== undefined) {
    normalized.cwd = server.cwd;
  }
  if (server.url !== undefined) {
    normalized.url = server.url;
  }
  return normalized;
}

function emptyCatalog(serverId: string): McpServerCatalog {
  return {
    discoveryError: null,
    instructions: "",
    prompts: [],
    resources: [],
    serverId,
    tools: []
  };
}

function toRuntimeToolName(tool: Pick<McpToolDescriptor, "name" | "serverId">): string {
  return `mcp__${tool.serverId}__${tool.name}`;
}

function parseRuntimeToolName(name: string): { serverId: string; toolName: string } | null {
  const match = /^mcp__([^_].*?)__(.+)$/u.exec(name);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return {
    serverId: match[1],
    toolName: match[2]
  };
}

function scoreTool(tool: McpToolDescriptor, query: string): number {
  if (query.length === 0) {
    return 1;
  }
  const haystack = `${tool.serverId} ${tool.name} ${tool.description}`.toLowerCase();
  return query
    .split(/\s+/u)
    .filter((token) => token.length > 0 && haystack.includes(token)).length;
}

function limitMcpOutput(content: JsonValue): JsonValue {
  const serialized = JSON.stringify(content);
  if (serialized.length <= 20_000) {
    return content;
  }
  return {
    truncated: true,
    preview: serialized.slice(0, 20_000)
  };
}
