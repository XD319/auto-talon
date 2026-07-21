import { describe, expect, it } from "vitest";

import {
  reasoningContentForReplay,
  shouldReplayReasoningContent
} from "../src/providers/reasoning-content.js";
import type { ConversationMessage } from "../src/types/index.js";

describe("reasoning content replay", () => {
  it("replays reasoning for assistant tool-call messages", () => {
    const message: ConversationMessage = {
      content: "Let me read the file.",
      reasoningContent: "Need to inspect README first.",
      role: "assistant",
      toolCalls: [
        {
          input: { path: "README.md" },
          reason: "read",
          toolCallId: "call-1",
          toolName: "read_file"
        }
      ]
    };

    expect(shouldReplayReasoningContent(message, [message], 0)).toBe(true);
    expect(reasoningContentForReplay(message, [message], 0)).toBe("Need to inspect README first.");
  });

  it("replays empty reasoning for tool-call messages when content was omitted", () => {
    const message: ConversationMessage = {
      content: "",
      role: "assistant",
      toolCalls: [
        {
          input: {},
          reason: "read",
          toolCallId: "call-1",
          toolName: "read_file"
        }
      ]
    };

    expect(reasoningContentForReplay(message, [message], 0)).toBe("");
  });

  it("replays reasoning on final assistant messages after tool calls", () => {
    const messages: ConversationMessage[] = [
      {
        content: "",
        reasoningContent: "Tool result received.",
        role: "assistant",
        toolCalls: [
          {
            input: {},
            reason: "read",
            toolCallId: "call-1",
            toolName: "read_file"
          }
        ]
      },
      {
        content: "ok",
        role: "tool",
        toolCallId: "call-1",
        toolName: "read_file"
      },
      {
        content: "Here is the summary.",
        reasoningContent: "Summarize tool output.",
        role: "assistant"
      }
    ];

    expect(shouldReplayReasoningContent(messages[2]!, messages, 2)).toBe(true);
    expect(reasoningContentForReplay(messages[2]!, messages, 2)).toBe("Summarize tool output.");
  });

  it("does not replay reasoning for pure chat without tool calls", () => {
    const messages: ConversationMessage[] = [
      { content: "hello", role: "user" },
      {
        content: "hi",
        reasoningContent: "Simple greeting.",
        role: "assistant"
      },
      { content: "how are you?", role: "user" }
    ];

    expect(shouldReplayReasoningContent(messages[1]!, messages, 1)).toBe(false);
    expect(reasoningContentForReplay(messages[1]!, messages, 1)).toBeUndefined();
  });
});

describe("resolveProviderFinalText", () => {
  it("falls back to reasoningContent for empty final messages", async () => {
    const { resolveProviderFinalText } = await import("../src/providers/reasoning-content.js");
    expect(
      resolveProviderFinalText({
        kind: "final",
        message: "",
        reasoningContent: "summary body"
      })
    ).toBe("summary body");
  });
});

describe("final output polish detection", () => {
  it("flags reasoning-only finals for polish", async () => {
    const { isReasoningOnlyFinal, shouldPolishFinalOutput } = await import(
      "../src/providers/reasoning-content.js"
    );
    const response = {
      kind: "final" as const,
      message: "",
      reasoningContent: "Bug Candidate #1: broken fps"
    };
    expect(isReasoningOnlyFinal(response)).toBe(true);
    expect(shouldPolishFinalOutput(response, "Bug Candidate #1: broken fps")).toEqual({
      polish: true,
      trigger: "reasoning_only_final"
    });
  });

  it("flags long internal reasoning drafts for polish", async () => {
    const { shouldPolishFinalOutput } = await import("../src/providers/reasoning-content.js");
    const draft =
      "Let me think about bug candidate #1. Wait, let me re-read game.js. " +
      "Actually wait, there is another issue.";
    const response = {
      kind: "final" as const,
      message: draft,
      reasoningContent: undefined
    };
    expect(shouldPolishFinalOutput(response, draft)).toEqual({
      polish: true,
      trigger: "internal_reasoning_detected"
    });
  });

  it("accepts concise user-facing finals", async () => {
    const { shouldPolishFinalOutput } = await import("../src/providers/reasoning-content.js");
    const answer =
      "1. `js/game.js` updateFPS() never accumulates fpsTime.\n2. `js/snake.js` hash collision check is a no-op.";
    const response = {
      kind: "final" as const,
      message: answer,
      reasoningContent: undefined
    };
    expect(shouldPolishFinalOutput(response, answer)).toEqual({
      polish: false,
      trigger: null
    });
  });
});

describe("final output acceptance", () => {
  it("rejects DSML tool markup masquerading as a final answer", async () => {
    const { isAcceptableUserFinalText, looksLikeToolMarkup } = await import(
      "../src/providers/reasoning-content.js"
    );
    const dsml =
      "<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name=\"read_file\">\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>";
    expect(looksLikeToolMarkup(dsml)).toBe(true);
    expect(
      isAcceptableUserFinalText(
        {
          kind: "final",
          message: dsml
        },
        dsml
      )
    ).toEqual({
      acceptable: false,
      reason: "tool_markup"
    });
  });

  it("rejects xfyun-style <tool_call> markup masquerading as a final answer", async () => {
    const { isAcceptableUserFinalText, looksLikeToolMarkup } = await import(
      "../src/providers/reasoning-content.js"
    );
    const markup =
      "<tool_call>write_file<arg_key>path</arg_key><arg_value>verify.mjs</arg_value></tool_call>";
    expect(looksLikeToolMarkup(markup)).toBe(true);
    expect(
      isAcceptableUserFinalText(
        {
          kind: "final",
          message: markup
        },
        markup
      )
    ).toEqual({
      acceptable: false,
      reason: "tool_markup"
    });
  });

  it("accepts polished bug-fix summaries", async () => {
    const { isAcceptableUserFinalText } = await import("../src/providers/reasoning-content.js");
    const answer = "修复已验证。Bug 在 `js/snake.js` 的 positionHash 更新顺序错误。";
    expect(
      isAcceptableUserFinalText(
        {
          kind: "final",
          message: answer
        },
        answer
      )
    ).toEqual({
      acceptable: true,
      reason: null
    });
  });
});
