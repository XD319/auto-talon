import type { JsonObject, ScheduleRecord } from "../../types/index.js";
import type { ToolsetName } from "../../tools/toolsets.js";
import { TOOLSET_NAMES } from "../../tools/toolsets.js";

export interface ScheduleNoAgentConfig {
  command: string;
  cwd?: string;
}

export function readScheduleSkills(schedule: ScheduleRecord): string[] {
  const skills = schedule.metadata.skills;
  if (!Array.isArray(skills)) {
    return [];
  }
  return skills.filter((skill): skill is string => typeof skill === "string" && skill.length > 0);
}

export function readScheduleToolsets(schedule: ScheduleRecord): ToolsetName[] {
  const toolsets = schedule.metadata.toolsets;
  if (!Array.isArray(toolsets)) {
    return [];
  }
  return toolsets.filter(
    (toolset): toolset is ToolsetName =>
      typeof toolset === "string" && TOOLSET_NAMES.includes(toolset as ToolsetName)
  );
}

export function readScheduleNoAgent(schedule: ScheduleRecord): ScheduleNoAgentConfig | null {
  const noAgent = readJsonObject(schedule.metadata.noAgent);
  if (noAgent === null) {
    return null;
  }
  const command = noAgent.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return null;
  }
  const cwd = noAgent.cwd;
  return {
    command,
    ...(typeof cwd === "string" && cwd.length > 0 ? { cwd } : {})
  };
}

export function readRepeatRemaining(schedule: ScheduleRecord): number | null {
  const value = schedule.metadata.repeatRemaining;
  if (value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

export function withScheduleMetadata(
  metadata: JsonObject,
  input: {
    allowDelegate?: boolean;
    noAgent?: ScheduleNoAgentConfig | null;
    repeatRemaining?: number | null;
    skills?: string[];
    toolsets?: ToolsetName[];
  }
): JsonObject {
  const next = { ...metadata };
  if (input.allowDelegate !== undefined) {
    next.allowDelegate = input.allowDelegate;
  }
  if (input.skills !== undefined) {
    next.skills = input.skills;
  }
  if (input.toolsets !== undefined) {
    next.toolsets = input.toolsets;
  }
  if (input.noAgent !== undefined) {
    if (input.noAgent === null) {
      delete next.noAgent;
    } else {
      next.noAgent = {
        command: input.noAgent.command,
        ...(input.noAgent.cwd !== undefined ? { cwd: input.noAgent.cwd } : {})
      };
    }
  }
  if (input.repeatRemaining !== undefined) {
    if (input.repeatRemaining === null) {
      delete next.repeatRemaining;
    } else {
      next.repeatRemaining = input.repeatRemaining;
    }
  }
  return next;
}

function readJsonObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as JsonObject;
}
