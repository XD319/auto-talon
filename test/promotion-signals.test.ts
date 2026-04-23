import { describe, expect, it } from "vitest";

import { computePromotionSignals, groupByPattern } from "../src/experience/promotion/promotion-signals.js";
import type { ExperienceRecord } from "../src/types/index.js";

describe("promotion signals", () => {
  it("passes repeated successful experiences", () => {
    const records = [
      createExperience("exp-1", { taskStatus: "succeeded", title: "Retry flaky tests" }),
      createExperience("exp-2", { taskStatus: "succeeded", title: "Retry flaky tests" }),
      createExperience("exp-3", { taskStatus: "succeeded", title: "Retry flaky tests" })
    ];
    const group = groupByPattern(records)[0];
    if (group === undefined) {
      throw new Error("expected a group");
    }
    const signals = computePromotionSignals(group, records, ["secret"]);
    expect(signals.successCount).toBe(3);
    expect(signals.successRate).toBeGreaterThan(0.8);
    expect(signals.riskLevel).toBe("low");
  });

  it("drops failure-heavy groups and high human judgment", () => {
    const accepted = [
      createExperience("exp-4", { sourceType: "reviewer", title: "Handle approvals" }),
      createExperience("exp-5", { sourceType: "reviewer", title: "Handle approvals" })
    ];
    const related = [...accepted, createExperience("exp-f", { type: "failure_lesson", status: "accepted" })];
    const group = groupByPattern(accepted)[0];
    if (group === undefined) {
      throw new Error("expected a group");
    }
    const signals = computePromotionSignals(group, related, ["approval"]);
    expect(signals.failureCount).toBeGreaterThan(0);
    expect(signals.humanJudgmentWeight).toBeGreaterThan(0.4);
    expect(signals.riskLevel).not.toBe("low");
  });
});

function createExperience(
  id: string,
  overrides: Partial<ExperienceRecord> & { taskStatus?: string } = {}
): ExperienceRecord {
  return {
    confidence: 0.9,
    content: "retry command and rerun tests",
    createdAt: "2026-04-23T00:00:00.000Z",
    experienceId: id,
    indexSignals: {
      errorCodes: [],
      paths: ["test/a.test.ts"],
      phrases: [],
      reviewers: [],
      scopes: [],
      sourceTypes: [],
      statuses: [],
      taskStatuses: [],
      tokens: [],
      types: [],
      valueScore: 0.8
    },
    keywordPhrases: ["retry flaky tests"],
    keywords: ["retry", "flaky", "tests"],
    metadata: {
      taskStatus: overrides.taskStatus ?? "succeeded"
    },
    promotedAt: null,
    promotedMemoryId: null,
    promotionTarget: null,
    provenance: {
      reviewerId: null,
      sourceLabel: "unit-test",
      taskId: "task-1",
      toolCallId: null,
      traceEventId: null
    },
    reviewedAt: "2026-04-23T00:00:00.000Z",
    scope: {
      paths: ["test/a.test.ts"],
      scope: "project",
      scopeKey: "repo"
    },
    sourceType: "task",
    status: "accepted",
    summary: "retry flaky test flow",
    title: "Retry flaky tests",
    type: "task_outcome",
    updatedAt: "2026-04-23T00:00:00.000Z",
    valueScore: 0.8,
    ...overrides
  };
}
