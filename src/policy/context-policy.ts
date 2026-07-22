import type {
  ContextPolicyFilterInput,
  ContextPolicyFilterResult,
  LongTermMemoryWriteDecision,
  LongTermMemoryWriteRequest
} from "../types/context.js";

export class ContextPolicy {
  public filterForModelContext(input: ContextPolicyFilterInput): ContextPolicyFilterResult {
    const decisions = input.fragments.map((fragment) => {
      if (fragment.status === "rejected" || fragment.status === "archived" || fragment.status === "stale") {
        return {
          allowed: false,
          fragment,
          reasonCode: "filtered_by_policy" as const,
          reason: "Rejected, stale, or archived memory cannot enter model context."
        };
      }

      if (fragment.scope !== "working" && fragment.scope !== "session_ref" && fragment.scope !== "skill_ref" && fragment.retentionPolicy.kind === "working") {
        return {
          allowed: false,
          fragment,
          reasonCode: "filtered_by_scope" as const,
          reason: "Working-retained memory cannot be injected outside the active working scope."
        };
      }

      if (fragment.retentionPolicy.kind === "ephemeral" && fragment.scope !== "working") {
        return {
          allowed: false,
          fragment,
          reasonCode: "filtered_by_retention" as const,
          reason: "Ephemeral memory is not eligible for cross-session model context."
        };
      }

      if (fragment.privacyLevel === "restricted" && fragment.scope !== "working") {
        return {
          allowed: false,
          fragment,
          reasonCode: "filtered_by_privacy" as const,
          reason: "Restricted memory is blocked from cross-session model injection."
        };
      }

      return {
        allowed: true,
        fragment,
        reasonCode: "allowed" as const,
        reason: "Memory passed the context boundary filter."
      };
    });

    return {
      allowedFragments: decisions.filter((decision) => decision.allowed).map((decision) => decision.fragment),
      decisions
    };
  }

  public decideLongTermWrite(request: LongTermMemoryWriteRequest): LongTermMemoryWriteDecision {
    if (request.privacyLevel === "restricted") {
      return {
        allowed: false,
        reason: "Restricted content is not auto-persisted into long-term memory.",
        targetScope: request.scope
      };
    }

    const compact = request.content.replace(/\s+/gu, " ").trim();
    const minLength = computeMinLongTermContentLength(compact);
    if (compact.length < minLength) {
      return {
        allowed: false,
        reason: "Content is too short to justify long-term memory persistence.",
        targetScope: request.scope
      };
    }
    if (compact.length > 8_000) {
      return {
        allowed: false,
        reason: "Content is too large for long-term memory and likely noisy.",
        targetScope: request.scope
      };
    }

    const source = request.sourceLabel.toLowerCase();
    if (source.includes("session compact") || source.includes("tool output")) {
      return {
        allowed: false,
        reason: "Session compaction and raw tool output are not auto-promoted to long-term memory.",
        targetScope: request.scope
      };
    }

    return {
      allowed: true,
      reason: "Content passed long-term memory quality gates.",
      targetScope: request.scope
    };
  }

  public redactText(value: string, privacyLevel: LongTermMemoryWriteRequest["privacyLevel"]): string {
    if (privacyLevel !== "restricted") {
      return value;
    }

    return "[REDACTED: restricted content]";
  }
}

/** CJK-heavy text packs more meaning per character; lower the character floor. */
export function computeMinLongTermContentLength(content: string): number {
  const cjkCount = [...content.matchAll(/[\u4e00-\u9fa5]/gu)].length;
  if (content.length === 0) {
    return 20;
  }
  if (cjkCount / content.length >= 0.4) {
    return 8;
  }
  return 20;
}
