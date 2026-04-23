import type { ExperienceRecord, PromotionGroup, PromotionSignals } from "../../types/index.js";

export function groupByPattern(records: ExperienceRecord[]): PromotionGroup[] {
  const groups = new Map<string, ExperienceRecord[]>();
  for (const record of records) {
    const key = createGroupKey(record);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  return [...groups.entries()].map(([key, entries]) => ({
    experiences: entries.map((entry) => ({
      content: entry.content,
      experienceId: entry.experienceId,
      keywordPhrases: entry.keywordPhrases,
      keywords: entry.keywords,
      sourceType: entry.sourceType,
      status: entry.status,
      summary: entry.summary,
      taskStatus: readTaskStatus(entry),
      title: entry.title,
      reviewerCount: entry.indexSignals.reviewers.length
    })),
    key,
    scopeKey: entries[0]?.scope.scopeKey ?? "",
    sourceExperienceIds: entries.map((entry) => entry.experienceId),
    title: entries[0]?.title ?? "Skill promotion candidate"
  }));
}

export function computePromotionSignals(
  group: PromotionGroup,
  related: ExperienceRecord[],
  riskDenyKeywords: string[]
): PromotionSignals {
  const members = group.experiences;
  const successMembers = members.filter((item) => {
    const taskSucceeded = item.taskStatus === "succeeded";
    const promoted = item.status === "promoted";
    const successType = item.status === "accepted" || item.status === "promoted";
    return successType && (taskSucceeded || promoted);
  });
  const failureCount = related.filter((item) => {
    if (item.type !== "failure_lesson" && item.type !== "gotcha") {
      return false;
    }
    const memberKeywords = new Set(members.flatMap((member) => member.keywords));
    return item.keywords.some((keyword) => memberKeywords.has(keyword));
  }).length;
  const successCount = successMembers.length;
  const attempts = Math.max(1, successCount + failureCount);
  const successRate = Number((successCount / attempts).toFixed(4));
  const stability = Number(computeStability(members).toFixed(4));
  const humanJudgmentWeight = Number(
    (
      members.filter((item) => item.sourceType === "reviewer" || item.reviewerCount > 0).length /
      Math.max(1, members.length)
    ).toFixed(4)
  );
  const riskLevel = computeRiskLevel(members, riskDenyKeywords);
  const reasons = [
    `success_count=${successCount}`,
    `failure_count=${failureCount}`,
    `success_rate=${successRate.toFixed(2)}`,
    `stability=${stability.toFixed(2)}`,
    `human_judgment_weight=${humanJudgmentWeight.toFixed(2)}`,
    `risk=${riskLevel}`
  ];

  return {
    failureCount,
    humanJudgmentWeight,
    reasons,
    riskLevel,
    stability,
    successCount,
    successRate
  };
}

function createGroupKey(record: ExperienceRecord): string {
  const title = record.title.toLowerCase().trim().replace(/\s+/gu, "_");
  const phrase = [...record.keywordPhrases].sort().slice(0, 5).join("|");
  return `${record.scope.scopeKey}:${title}:${phrase}`;
}

function computeStability(
  members: Array<{ keywords: string[]; keywordPhrases: string[]; content: string }>
): number {
  if (members.length <= 1) {
    return 1;
  }
  const keywordSets = members.map((item) => new Set([...item.keywords, ...item.keywordPhrases]));
  let total = 0;
  let count = 0;
  for (let i = 0; i < keywordSets.length; i += 1) {
    for (let j = i + 1; j < keywordSets.length; j += 1) {
      const left = keywordSets[i];
      const right = keywordSets[j];
      if (left === undefined || right === undefined) {
        continue;
      }
      const intersection = [...left].filter((token) => right.has(token)).length;
      const union = new Set([...left, ...right]).size;
      total += union === 0 ? 0 : intersection / union;
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

function computeRiskLevel(
  members: Array<{ content: string; summary: string; title: string; keywords: string[] }>,
  riskDenyKeywords: string[]
): "low" | "medium" | "high" {
  const joined = members
    .flatMap((item) => [...item.keywords, item.content, item.summary, item.title])
    .join(" ")
    .toLowerCase();
  const hitCount = riskDenyKeywords.filter((keyword) => joined.includes(keyword.toLowerCase())).length;
  if (hitCount >= 2) {
    return "high";
  }
  if (hitCount === 1) {
    return "medium";
  }
  return "low";
}

function readTaskStatus(experience: ExperienceRecord): string | null {
  const taskStatus = experience.metadata.taskStatus;
  return typeof taskStatus === "string" ? taskStatus : null;
}
