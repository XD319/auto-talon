import type { SkillRegistry } from "../../skills/skill-registry.js";
import type { ScheduleRecord } from "../../types/index.js";

import { readScheduleSkills } from "./schedule-metadata.js";

export function buildScheduledTaskInput(schedule: ScheduleRecord, registry: SkillRegistry): string {
  const skillIds = readScheduleSkills(schedule);
  if (skillIds.length === 0) {
    return schedule.input;
  }

  const sections: string[] = [];
  for (const skillId of skillIds) {
    const view = registry.viewSkill(skillId, []);
    if (view === null) {
      sections.push(`## Skill ${skillId}\n(unavailable)`);
      continue;
    }
    sections.push(`## Skill ${skillId}\n${view.body}`);
  }
  sections.push(schedule.input);
  return sections.join("\n\n");
}
