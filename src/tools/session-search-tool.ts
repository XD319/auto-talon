import { z } from "zod";

import type { SessionMessageKind, SessionMessageSearchHit } from "../types/index.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const sessionSearchSchema = z.object({
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(50).default(20),
  sort: z.enum(["relevance", "recent"]).default("relevance"),
  roleFilter: z.array(z.enum(["user", "assistant", "tool", "system"])).default(["user", "assistant"]),
  scope: z.enum(["session", "global"]).default("global"),
  sessionIdPrefix: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  aroundMessageId: z.string().min(1).optional(),
  window: z.number().int().nonnegative().max(20).default(2)
}).superRefine((value, context) => {
  const hasScrollPart = value.sessionId !== undefined || value.aroundMessageId !== undefined;
  if (hasScrollPart && (value.sessionId === undefined || value.aroundMessageId === undefined)) {
    context.addIssue({ code: "custom", message: "scroll requires sessionId and aroundMessageId" });
  }
  if (hasScrollPart && value.query !== undefined) {
    context.addIssue({ code: "custom", message: "scroll cannot be combined with query" });
  }
});

export interface PreparedSessionSearchInput {
  mode: "discovery" | "scroll" | "browse";
  limit: number;
  query?: string;
  sort: "relevance" | "recent";
  roleFilter: SessionMessageKind[];
  sessionIdPrefix?: string;
  sessionId?: string;
  aroundMessageId?: string;
  window: number;
  ownerUserId: string;
  workspaceRoot: string;
}

export interface SessionSearchService {
  search: (input: {
    limit: number; query: string; sessionIdPrefix?: string; ownerUserId?: string;
    workspaceRoot?: string; roleFilter?: SessionMessageKind[]; window?: number;
  }) => SessionMessageSearchHit[];
  scroll?: (input: {
    sessionId: string; aroundMessageId: string; window: number;
    ownerUserId?: string; workspaceRoot?: string;
  }) => SessionMessageSearchHit[];
  browse?: (input: {
    limit?: number; ownerUserId?: string; workspaceRoot?: string;
  }) => SessionMessageSearchHit[];
}

export interface SessionSearchToolOptions {
  searchService: SessionSearchService;
}

export class SessionSearchTool
  implements ToolDefinition<typeof sessionSearchSchema, PreparedSessionSearchInput>
{
  public readonly name = "session_search";
  public readonly description =
    "Search the current requester's saved conversations. Discovery uses query; scroll uses sessionId + aroundMessageId; browse omits query. Results include session bookends, message windows, counts, and continuation ids. Tool messages are excluded unless roleFilter explicitly includes tool.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = sessionSearchSchema;

  public constructor(private readonly options: SessionSearchToolOptions) {}

  public prepare(input: unknown, context: ToolExecutionContext): ToolPreparation<PreparedSessionSearchInput> {
    const parsed = this.inputSchema.parse(input);
    const sessionIdFromMetadata = typeof context.taskMetadata?.sessionId === "string"
      ? context.taskMetadata.sessionId
      : undefined;
    const mode = parsed.sessionId !== undefined ? "scroll" : parsed.query !== undefined ? "discovery" : "browse";
    const sessionIdPrefix = parsed.sessionIdPrefix ??
      (parsed.scope === "session" ? sessionIdFromMetadata : undefined);
    return {
      governance: {
        pathScope: "workspace",
        summary: mode === "discovery" ? `Search session messages for ${parsed.query}` : `${mode} session history`
      },
      preparedInput: {
        mode,
        limit: parsed.limit,
        sort: parsed.sort,
        roleFilter: parsed.roleFilter.map(toStoredRole),
        window: parsed.window,
        ownerUserId: context.userId,
        workspaceRoot: context.workspaceRoot,
        ...(parsed.query !== undefined ? { query: parsed.query } : {}),
        ...(sessionIdPrefix !== undefined ? { sessionIdPrefix } : {}),
        ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
        ...(parsed.aroundMessageId !== undefined ? { aroundMessageId: parsed.aroundMessageId } : {})
      },
      sandbox: { kind: "prompt", pathScope: "workspace", target: "interactive_user" }
    };
  }

  public execute(input: PreparedSessionSearchInput): Promise<ToolExecutionResult> {
    let hits: SessionMessageSearchHit[];
    if (input.mode === "scroll") {
      hits = this.options.searchService.scroll?.({
        sessionId: input.sessionId ?? "",
        aroundMessageId: input.aroundMessageId ?? "",
        window: input.window,
        ownerUserId: input.ownerUserId,
        workspaceRoot: input.workspaceRoot
      }) ?? [];
    } else if (input.mode === "browse") {
      hits = this.options.searchService.browse?.({
        limit: input.limit,
        ownerUserId: input.ownerUserId,
        workspaceRoot: input.workspaceRoot
      }) ?? [];
    } else {
      hits = this.options.searchService.search({
        limit: input.limit,
        query: input.query ?? "",
        ownerUserId: input.ownerUserId,
        workspaceRoot: input.workspaceRoot,
        roleFilter: input.roleFilter,
        window: input.window,
        ...(input.sessionIdPrefix !== undefined ? { sessionIdPrefix: input.sessionIdPrefix } : {})
      });
      if (input.sort === "recent") {
        hits.sort((left, right) => right.sequence - left.sequence);
      }
    }
    return Promise.resolve({
      output: formatHits(hits),
      success: true,
      summary: hits.length === 0 ? "No session messages matched." : `Found ${hits.length} session result(s).`
    });
  }
}

function toStoredRole(role: "user" | "assistant" | "tool" | "system"): SessionMessageKind {
  if (role === "assistant") return "agent";
  if (role === "tool") return "activity";
  return role;
}

function formatHits(hits: SessionMessageSearchHit[]): string {
  if (hits.length === 0) return "No matches.";
  return hits.map((hit, index) => [
    `Result ${index + 1}`,
    `session_id=${hit.sessionId}`,
    `title=${hit.sessionTitle}`,
    `message_id=${hit.messageId || "[none]"}`,
    `role=${hit.role ?? "unknown"}`,
    `preview=${hit.preview.replace(/\s+/gu, " ").trim()}`,
    `bookends=${hit.firstMessageId ?? "none"}..${hit.lastMessageId ?? "none"}`,
    `total_messages=${hit.totalMessages ?? "unknown"}`,
    `previous_message_id=${hit.previousMessageId ?? "none"}`,
    `next_message_id=${hit.nextMessageId ?? "none"}`,
    ...(hit.before ?? []).map((message) => `before[${message.messageId}]=${message.kind}:${previewPayload(message.payload)}`),
    ...(hit.after ?? []).map((message) => `after[${message.messageId}]=${message.kind}:${previewPayload(message.payload)}`)
  ].join("\n")).join("\n\n");
}

function previewPayload(payload: Record<string, unknown>): string {
  const value = [payload.text, payload.message, payload.title].find((item) => typeof item === "string");
  return typeof value === "string" ? value.replace(/\s+/gu, " ").slice(0, 160) : "[non-text]";
}