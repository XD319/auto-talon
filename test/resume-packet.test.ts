import { describe, expect, it } from "vitest";

import { ResumePacketBuilder } from "../src/runtime/sessions/resume-packet-builder.js";
import { similarText } from "../src/runtime/sessions/text-similarity.js";
import type { SessionStateProjection } from "../src/runtime/sessions/session-state-projector.js";
import type { AppConfig } from "../src/runtime/bootstrap.js";

describe("text similarity", () => {
  it("treats identical or near-identical text as similar", () => {
    expect(similarText("修复严重 Bug", "修复严重 Bug")).toBe(true);
    expect(similarText("目前这个项目还有哪些bug", "目前这个项目还有哪些 bug")).toBe(true);
  });

  it("treats changed intent as different", () => {
    expect(similarText("目前这个项目还有哪些bug", "修复严重 Bug")).toBe(false);
  });
});

describe("ResumePacketBuilder", () => {
  it("injects KnownCurrentDirective when continuation intent changes", () => {
    const projection: SessionStateProjection = {
      commitmentState: {
        blockedReason: null,
        currentObjective: null,
        nextAction: null,
        openCommitments: [],
        pendingDecision: null
      },
      messages: [
        {
          role: "system",
          content: "KnownActiveGoal: 目前这个项目还有哪些bug"
        }
      ],
      sessionSummary: {
        createdAt: "2026-06-26T00:00:00.000Z",
        decisions: [],
        goal: "目前这个项目还有哪些bug",
        keywords: [],
        nextActions: [],
        openLoops: [],
        runId: "run-1",
        sessionId: "session-1",
        sessionSummaryId: "summary-1",
        summary: "goal=目前这个项目还有哪些bug",
        taskId: "task-1",
        trigger: "final"
      }
    };
    const builder = new ResumePacketBuilder({
      config: {
        defaultMaxIterations: 12,
        defaultProfileId: "executor",
        defaultTimeoutMs: 120000,
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedCostUsd: 0,
          usedInput: 0,
          usedOutput: 0
        },
        workspaceRoot: "D:/repo"
      } as AppConfig,
      stateProjector: {
        projectState: () => projection
      }
    });

    const packet = builder.buildResumePacket("session-1", "修复严重 Bug");
    const resume = packet.metadata?.sessionResume as { contextMessages: Array<{ content: string }> };

    expect(
      resume.contextMessages.some((message) =>
        message.content.startsWith("KnownCurrentDirective:")
      )
    ).toBe(true);
  });

  it("includes fallback context messages when no session summary exists", () => {
    const projection: SessionStateProjection = {
      commitmentState: {
        activeNextActions: [],
        blockedReason: null,
        currentObjective: null,
        nextAction: null,
        openCommitments: [],
        pendingDecision: null
      },
      messages: [
        { role: "user", content: "Prior user request before compaction" },
        { role: "assistant", content: "Prior assistant reply" }
      ],
      sessionSummary: null
    };
    const builder = new ResumePacketBuilder({
      config: {
        defaultMaxIterations: 12,
        defaultProfileId: "executor",
        defaultTimeoutMs: 120000,
        tokenBudget: {
          inputLimit: 1000,
          outputLimit: 1000,
          reservedOutput: 100,
          usedCostUsd: 0,
          usedInput: 0,
          usedOutput: 0
        },
        workspaceRoot: "D:/repo"
      } as AppConfig,
      stateProjector: {
        projectState: () => projection
      }
    });

    const packet = builder.buildResumePacket("session-1", "continue the work");
    const resume = packet.metadata?.sessionResume as { contextMessages: Array<{ content: string; role: string }> };

    expect(resume.contextMessages.length).toBeGreaterThan(0);
    expect(resume.contextMessages.some((message) => message.content.includes("Prior user request"))).toBe(true);
  });
});
