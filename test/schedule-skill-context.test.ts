import { describe, expect, it } from "vitest";

import {
  buildScheduledTaskInput,
  verifyScheduledSkills
} from "../src/runtime/scheduler/schedule-skill-context.js";
import type { SkillRegistry } from "../src/skills/skill-registry.js";
import type { ScheduleRecord } from "../src/types/index.js";

function scheduleWithSkills(skillIds: string[], input: string): ScheduleRecord {
  return {
    agentProfileId: "executor",
    createdAt: new Date().toISOString(),
    cron: null,
    cwd: "/tmp",
    delivery: { targets: ["inbox"] },
    every: null,
    input,
    metadata: { skills: skillIds },
    name: "skill schedule",
    nextRunAt: null,
    ownerUserId: "local-user",
    providerName: "mock",
    runAt: null,
    scheduleId: "sched-1",
    sessionId: null,
    status: "active",
    timezone: "UTC",
    updatedAt: new Date().toISOString()
  };
}

describe("buildScheduledTaskInput", () => {
  it("prepends skill bodies before schedule input", () => {
    const registry = {
      viewSkill: (skillId: string) =>
        skillId === "demo-skill"
          ? {
              body: "skill body text",
              loadedAttachments: [],
              metadata: { id: skillId, name: skillId }
            }
          : null
    } as unknown as SkillRegistry;

    const input = buildScheduledTaskInput(
      scheduleWithSkills(["demo-skill"], "run the task"),
      registry
    );
    expect(input).toContain("## Skill demo-skill");
    expect(input).toContain("skill body text");
    expect(input.endsWith("run the task")).toBe(true);
  });

  it("reports missing required scheduled skills and hashes loaded skills", () => {
    const registry = {
      viewSkill: (skillId: string) =>
        skillId === "demo-skill"
          ? {
              body: "skill body text",
              loadedAttachments: [],
              metadata: { id: skillId, name: skillId, version: "1.0.0" }
            }
          : null
    } as unknown as SkillRegistry;

    const result = verifyScheduledSkills(
      scheduleWithSkills(["demo-skill", "missing-skill"], "run the task"),
      registry
    );

    expect(result.loadedSkills).toHaveLength(1);
    expect(result.loadedSkills[0]?.skillId).toBe("demo-skill");
    expect(result.loadedSkills[0]?.hash).toHaveLength(64);
    expect(result.missingSkillIds).toEqual(["missing-skill"]);
  });
});
