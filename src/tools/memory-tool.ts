import { createHash } from "node:crypto";
import { z } from "zod";

import { scanMemoryContent } from "../memory/memory-safety.js";
import type {
  InboxRepository,
  JsonObject,
  MemoryRecord,
  MemoryRepository,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const memoryToolSchema = z.object({
  action: z.enum(["add", "replace", "remove"]),
  target: z.enum(["profile", "project"]),
  content: z.string().max(8000).optional(),
  oldText: z.string().min(1).max(8000).optional(),
  reason: z.string().min(1).max(1000)
}).superRefine((value, context) => {
  if ((value.action === "add" || value.action === "replace") && !value.content?.trim()) {
    context.addIssue({ code: "custom", message: "content is required for add/replace" });
  }
  if ((value.action === "replace" || value.action === "remove") && !value.oldText?.trim()) {
    context.addIssue({ code: "custom", message: "oldText is required for replace/remove" });
  }
});

type MemoryToolInput = z.infer<typeof memoryToolSchema>;

export class MemoryTool implements ToolDefinition<typeof memoryToolSchema, MemoryToolInput> {
  public readonly name = "memory";
  public readonly description = [
    "Suggest an approved core-memory change; this never edits memory directly.",
    "Save only stable preferences, project conventions, environment facts, corrections, or important decisions.",
    "Never save raw logs, temporary state, credentials, prompt instructions, or easily reconstructed facts.",
    "Use action=add|replace|remove and target=profile|project. replace/remove require an oldText substring that uniquely identifies one core memory."
  ].join(" ");
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "runtime_mutation" as const;
  public readonly toolKind = "control_command" as const;
  public readonly inputSchema = memoryToolSchema;

  public constructor(private readonly dependencies: {
    enabled: () => boolean;
    inboxRepository: InboxRepository;
    memoryRepository: MemoryRepository;
  }) {}

  public checkAvailability(): { available: boolean; reason: string } {
    const enabled = this.dependencies.enabled();
    return {
      available: enabled,
      reason: enabled ? "Long-term memory is enabled." : "Long-term memory is disabled. Use /memory on to enable it."
    };
  }

  public prepare(input: unknown): ToolPreparation<MemoryToolInput> {
    const parsed = this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: `Suggest ${parsed.action} for ${parsed.target} memory`
      },
      preparedInput: parsed,
      sandbox: { kind: "prompt", pathScope: "workspace", target: "interactive_user" }
    };
  }

  public execute(input: MemoryToolInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (!this.dependencies.enabled()) {
      return Promise.resolve({
        success: false,
        errorCode: "tool_unavailable",
        errorMessage: "Long-term memory is disabled. Use /memory on to enable it."
      });
    }
    const safety = scanMemoryContent([input.content ?? "", input.oldText ?? ""].join("\n"));
    if (!safety.allowed) {
      return Promise.resolve({
        success: false,
        errorCode: "policy_denied",
        errorMessage: `Memory suggestion rejected: ${safety.reasons.join("; ")}`
      });
    }
    const scopeKey = input.target === "profile"
      ? `${context.userId}:${context.agentProfileId}`
      : context.workspaceRoot;
    const targetMemory = input.action === "add"
      ? null
      : this.resolveUniqueTarget(input, scopeKey);
    if (targetMemory instanceof Error) {
      return Promise.resolve({
        success: false,
        errorCode: "tool_validation_error",
        errorMessage: targetMemory.message
      });
    }
    const sessionId = typeof context.taskMetadata?.sessionId === "string"
      ? context.taskMetadata.sessionId
      : null;
    const sourceMessageId = typeof context.taskMetadata?.sourceMessageId === "string"
      ? context.taskMetadata.sourceMessageId
      : null;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([context.userId, scopeKey, input.action, input.oldText, input.content, sessionId, sourceMessageId]))
      .digest("hex");
    const existing = this.dependencies.inboxRepository.findByDedup({
      userId: context.userId,
      dedupKey: `memory_suggestion:${fingerprint}`
    });
    const item = existing ?? this.dependencies.inboxRepository.create({
      userId: context.userId,
      taskId: context.taskId,
      sessionId,
      category: "memory_suggestion",
      severity: "action_required",
      title: `${input.action} ${input.target} memory`,
      summary: input.reason,
      bodyMd: input.content ?? input.oldText ?? null,
      actionHint: "Review with talon memory review-queue list",
      dedupKey: `memory_suggestion:${fingerprint}`,
      metadata: {
        suggestionVersion: 2,
        action: input.action,
        target: input.target,
        scopeKey,
        content: input.content ?? null,
        oldText: input.oldText ?? null,
        targetMemoryId: targetMemory?.memoryId ?? null,
        sourceSessionId: sessionId,
        sourceMessageId,
        reason: input.reason,
        draft: input.action === "add" ? buildAddDraft(input, context, scopeKey) : null
      }
    });
    const output: JsonObject = {
      inboxId: item.inboxId,
      status: item.status,
      action: input.action,
      target: input.target,
      message: "Suggestion queued for review. If accepted, it will be injected starting with the next session."
    };
    return Promise.resolve({
      success: true,
      output,
      summary: `Queued memory suggestion ${item.inboxId}; accepted changes take effect next session.`
    });
  }

  private resolveUniqueTarget(input: MemoryToolInput, scopeKey: string): MemoryRecord | Error {
    const oldText = input.oldText?.trim() ?? "";
    const matches = this.dependencies.memoryRepository.list({
      scope: input.target,
      scopeKey,
      tier: "core",
      includeArchived: false,
      includeExpired: false,
      includeRejected: false,
      includeStale: false
    }).filter((memory) => memory.content.includes(oldText));
    if (matches.length === 0) {
      return new Error("oldText did not match any active core memory; provide exact, more specific text.");
    }
    if (matches.length > 1) {
      return new Error("oldText matched multiple core memories; provide a longer, unique substring.");
    }
    return matches[0] ?? new Error("Memory target was not found.");
  }
}

function buildAddDraft(input: MemoryToolInput, context: ToolExecutionContext, scopeKey: string): JsonObject {
  const content = input.content?.trim() ?? "";
  return {
    confidence: 0.9,
    content,
    keywords: content.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean).slice(0, 12),
    metadata: { memorySuggestionAction: "add" },
    privacyLevel: "internal",
    retentionPolicy: {
      kind: input.target,
      reason: input.reason,
      ttlDays: null
    },
    scope: input.target,
    scopeKey,
    source: {
      label: "Agent memory suggestion",
      sourceType: "user_input",
      taskId: context.taskId,
      toolCallId: null,
      traceEventId: null
    },
    summary: content.slice(0, 160),
    title: content.slice(0, 80),
    tier: "core"
  };
}