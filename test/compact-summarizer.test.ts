import { describe, expect, it } from "vitest";

import {
  collectStructuredSummaryFields,
  DeterministicCompactSummarizer,
  ProviderSubagentSummarizer
} from "../src/memory/compact-summarizer.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../src/types/index.js";

class FinalSummaryProvider implements Provider {
  public readonly name = "final-summary-provider";

  public generate(input: ProviderRequest): Promise<ProviderResponse> {
    void input;
    return Promise.resolve({
      kind: "final",
      message:
        "goal=Ship feature\nlatest_user_request=continue\ncompletedWork=done\nfilesTouched=src/app.ts\ncommandsRun=npm test\nblockers=[none]\nnextActions=commit\ntool_signals=ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

class ThrowingSummaryProvider implements Provider {
  public readonly name = "throwing-summary-provider";

  public generate(input: ProviderRequest): Promise<ProviderResponse> {
    void input;
    throw new Error("provider failed");
  }
}

class EmptyFinalSummaryProvider implements Provider {
  public readonly name = "empty-final-summary-provider";

  public generate(input: ProviderRequest): Promise<ProviderResponse> {
    void input;
    return Promise.resolve({
      kind: "final",
      message: "",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

class ReasoningOnlySummaryProvider implements Provider {
  public readonly name = "reasoning-only-summary-provider";

  public generate(input: ProviderRequest): Promise<ProviderResponse> {
    void input;
    return Promise.resolve({
      kind: "final",
      message: "",
      reasoningContent:
        "goal=Ship feature\nlatest_user_request=continue\ncompletedWork=done\nfilesTouched=src/app.ts\ncommandsRun=npm test\nblockers=[none]\nremaining_work=commit\ntool_signals=ok",
      usage: { inputTokens: 1, outputTokens: 1 }
    });
  }
}

describe("compact summarizer", () => {
  const compactInput = {
    maxMessagesBeforeCompact: 8,
    messages: [
      { content: "Deploy with apiKey=sk-abcdef1234567890 and ping me at test@example.com", role: "user" as const },
      {
        content: "I will run shell next and then verify tests",
        role: "assistant" as const
      },
      {
        content:
          "{\"command\":\"npm test\",\"path\":\"src/app.ts\",\"stderr\":\"error: timeout\",\"stdout\":\"done\"}",
        role: "tool" as const,
        toolCallId: "tc-1",
        toolName: "Shell"
      },
      {
        content: "Next I should update docs and commit",
        role: "assistant" as const
      }
    ],
    reason: "message_count" as const,
    sessionScopeKey: "session-1",
    taskId: "task-1"
  };

  it("builds structured deterministic summary and redacts sensitive values", async () => {
    const summarizer = new DeterministicCompactSummarizer();
    const result = await summarizer.summarize(compactInput);
    expect(result.summarizerId).toBe("deterministic");
    expect(result.summary).toContain("## Goal");
    expect(result.summary).toContain("## All User Messages");
    expect(result.summary).toContain("## Relevant Files");
    expect(result.summary).toContain("## Blocked");
    expect(result.summary).toContain("### Remaining Work");
    expect(result.summary).toContain("apiKey=[REDACTED]");
    expect(result.summary).toContain("[REDACTED_EMAIL]");
  });

  it("preserves assistant reasoning in findings section", () => {
    const fields = collectStructuredSummaryFields({
      ...compactInput,
      messages: [
        ...compactInput.messages,
        {
          content:
            "Bug 1: score can go negative when addScore receives invalid input without guarding downstream UI updates.",
          role: "assistant" as const
        }
      ]
    });
    expect(fields.findings).toContain("Bug 1");
  });

  it("preserves reasoningContent-only assistant text in findings section", () => {
    const fields = collectStructuredSummaryFields({
      ...compactInput,
      messages: [
        ...compactInput.messages,
        {
          content: "",
          reasoningContent:
            "Bug 1: updateFPS() in game.js never accumulates fpsTime, so displayed FPS is wrong.",
          role: "assistant" as const
        }
      ]
    });
    expect(fields.findings).toContain("updateFPS()");
  });

  it("uses provider_subagent output when provider succeeds", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => new FinalSummaryProvider());
    const result = await summarizer.summarize(compactInput);
    expect(result.summarizerId).toContain("provider_subagent:final-summary-provider");
    expect(result.summary).toContain("completedWork=done");
  });

  it("accepts thinking-mode summaries from reasoning_content when content is empty", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => new ReasoningOnlySummaryProvider());
    const result = await summarizer.summarize(compactInput);
    expect(result.summarizerId).toContain("provider_subagent:reasoning-only-summary-provider");
    expect(result.summary).toContain("completedWork=done");
  });

  it("throws when provider_subagent returns an empty final response", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => new EmptyFinalSummaryProvider());
    await expect(summarizer.summarize(compactInput)).rejects.toMatchObject({
      code: "compact_summarizer_failed",
      message: "Provider subagent summarizer returned an empty final response."
    });
  });

  it("throws when provider_subagent fails", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => new ThrowingSummaryProvider());
    await expect(summarizer.summarize(compactInput)).rejects.toThrow("provider failed");
  });

  it("throws when provider_subagent is unavailable", async () => {
    const summarizer = new ProviderSubagentSummarizer(() => null);
    await expect(summarizer.summarize(compactInput)).rejects.toMatchObject({
      code: "compact_summarizer_unavailable"
    });
  });

  it("throws when provider_subagent helper context is too small", async () => {
    const summarizer = new ProviderSubagentSummarizer(
      () => new FinalSummaryProvider(),
      { maxInputTokens: 1 }
    );
    await expect(summarizer.summarize(compactInput)).rejects.toMatchObject({
      code: "compact_summarizer_unavailable"
    });
  });
});
