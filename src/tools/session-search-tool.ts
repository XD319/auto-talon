import { z } from "zod";

import type { SessionMessageSearchHit } from "../types/index.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const sessionSearchSchema = z.object({
  limit: z.number().int().positive().max(50).default(20),
  query: z.string().min(1),
  sessionIdPrefix: z.string().min(1).optional()
});

export interface PreparedSessionSearchInput {
  limit: number;
  query: string;
  sessionIdPrefix?: string;
}

export interface SessionSearchService {
  search: (input: PreparedSessionSearchInput) => SessionMessageSearchHit[];
}

export interface SessionSearchToolOptions {
  searchService: SessionSearchService;
}

export class SessionSearchTool
  implements ToolDefinition<typeof sessionSearchSchema, PreparedSessionSearchInput>
{
  public readonly name = "session_search";
  public readonly description =
    "Search prior session messages across the workspace using SQLite FTS. Returns matching snippets without calling the model.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = sessionSearchSchema;
  public readonly inputSchemaDescriptor = {
    properties: {
      limit: { type: "number" },
      query: { type: "string" },
      sessionIdPrefix: { type: "string" }
    },
    required: ["query"],
    type: "object"
  };

  public constructor(private readonly options: SessionSearchToolOptions) {}

  public prepare(input: unknown, _context: ToolExecutionContext): ToolPreparation<PreparedSessionSearchInput> {
    void _context;
    const parsedInput = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: `Search session messages for ${parsedInput.query}`
      },
      preparedInput: {
        limit: parsedInput.limit,
        query: parsedInput.query,
        ...(parsedInput.sessionIdPrefix !== undefined ? { sessionIdPrefix: parsedInput.sessionIdPrefix } : {})
      },
      sandbox: {
        kind: "prompt",
        pathScope: "workspace",
        target: "interactive_user"
      }
    };
  }

  public execute(
    input: PreparedSessionSearchInput,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    void _context;
    const hits = this.options.searchService.search(input);
    return Promise.resolve({
      output: formatHits(hits),
      success: true,
      summary: hits.length === 0 ? "No session messages matched the query." : `Found ${hits.length} session message matches.`
    });
  }
}

function formatHits(hits: SessionMessageSearchHit[]): string {
  if (hits.length === 0) {
    return "No matches.";
  }
  return hits
    .map(
      (hit, index) =>
        [
          `Match ${index + 1}`,
          `session_id=${hit.sessionId}`,
          `title=${hit.sessionTitle}`,
          `message_id=${hit.messageId}`,
          `preview=${hit.preview.replace(/\s+/gu, " ").trim()}`
        ].join("\n")
    )
    .join("\n\n");
}
