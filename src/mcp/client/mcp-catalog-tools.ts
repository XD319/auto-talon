import { z } from "zod";

import type { McpClientManager } from "./mcp-client-manager.js";
import type {
  JsonObject,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../../types/index.js";

const toolSearchSchema = z.object({
  limit: z.number().int().positive().max(25).default(8),
  query: z.string().default("")
});

const resourceSchema = z.object({
  uri: z.string().min(1)
});

const promptSchema = z.object({
  arguments: z.record(z.string(), z.json()).default({}),
  name: z.string().min(1),
  serverId: z.string().min(1)
});

type ToolSearchInput = z.infer<typeof toolSearchSchema>;
type ResourceInput = z.infer<typeof resourceSchema>;
type PromptInput = z.infer<typeof promptSchema>;

export class McpToolSearchTool implements ToolDefinition<typeof toolSearchSchema, ToolSearchInput> {
  public readonly name = "mcp_tool_search";
  public readonly description =
    "Search configured MCP tool catalogs and make matching MCP tools available for the next turn.";
  public readonly capability = "mcp.invoke" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = toolSearchSchema;

  public constructor(
    private readonly manager: McpClientManager,
    private readonly registerTool: (tool: ToolDefinition) => void
  ) {}

  public prepare(input: unknown): ToolPreparation<ToolSearchInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "network",
        summary: `Search MCP tools for "${parsed.query}"`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "mcp",
        pathScope: "network",
        serverId: "catalog",
        target: "mcp_tool_search",
        toolName: "mcp_tool_search"
      }
    };
  }

  public async execute(input: ToolSearchInput): Promise<ToolExecutionResult> {
    const result = await this.manager.searchTools(input.query, input.limit);
    const matches = [];
    for (const match of result.matches) {
      const materialized = this.manager.materializeTool(match.callableToolName);
      if (materialized !== null) {
        this.registerTool(materialized);
      }
      matches.push({
        callableToolName: match.callableToolName,
        description: match.description,
        inputSchema: match.inputSchema,
        materialized: materialized !== null,
        name: match.name,
        serverId: match.serverId
      });
    }
    return {
      output: {
        matches,
        servers: result.catalog.map((catalog) => ({
          discoveryError: catalog.discoveryError,
          instructions: catalog.instructions,
          promptCount: catalog.prompts.length,
          resourceCount: catalog.resources.length,
          serverId: catalog.serverId,
          toolCount: catalog.tools.length
        }))
      },
      success: true,
      summary: `Found ${matches.length} MCP tool match(es).`
    };
  }
}

export class McpResourceTool implements ToolDefinition<typeof resourceSchema, ResourceInput> {
  public readonly name = "mcp_resource";
  public readonly description = "Read a resource from a configured MCP server by URI.";
  public readonly capability = "mcp.invoke" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = resourceSchema;

  public constructor(private readonly manager: McpClientManager) {}

  public prepare(input: unknown): ToolPreparation<ResourceInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "network",
        summary: `Read MCP resource ${parsed.uri}`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "mcp",
        pathScope: "network",
        serverId: "resource",
        target: parsed.uri,
        toolName: "mcp_resource"
      }
    };
  }

  public async execute(input: ResourceInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const content = await this.manager.readResource(input.uri, { signal: context.signal });
      return {
        output: {
          content,
          uri: input.uri
        },
        success: true,
        summary: `Read MCP resource ${input.uri}`
      };
    } catch (error) {
      return {
        errorCode: "tool_execution_error",
        errorMessage: error instanceof Error ? error.message : String(error),
        success: false
      };
    }
  }
}

export class McpPromptTool implements ToolDefinition<typeof promptSchema, PromptInput> {
  public readonly name = "mcp_prompt";
  public readonly description = "Load a reusable prompt template from a configured MCP server.";
  public readonly capability = "mcp.invoke" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "external_read_only" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = promptSchema;

  public constructor(private readonly manager: McpClientManager) {}

  public prepare(input: unknown): ToolPreparation<PromptInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "network",
        summary: `Load MCP prompt ${parsed.serverId}/${parsed.name}`
      },
      preparedInput: parsed,
      sandbox: {
        kind: "mcp",
        pathScope: "network",
        serverId: parsed.serverId,
        target: `${parsed.serverId}/${parsed.name}`,
        toolName: "mcp_prompt"
      }
    };
  }

  public async execute(input: PromptInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    try {
      const content = await this.manager.getPrompt(
        input.serverId,
        input.name,
        input.arguments as JsonObject,
        { signal: context.signal }
      );
      return {
        output: {
          content,
          name: input.name,
          serverId: input.serverId
        },
        success: true,
        summary: `Loaded MCP prompt ${input.serverId}/${input.name}`
      };
    } catch (error) {
      return {
        errorCode: "tool_execution_error",
        errorMessage: error instanceof Error ? error.message : String(error),
        success: false
      };
    }
  }
}
