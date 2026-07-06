import { z } from "zod";

import type { AgentProfile, AgentProfileId } from "../types/index.js";

const agentProfileSchema = z.object({
  description: z.string().min(1),
  displayName: z.string().min(1),
  id: z.enum(["planner", "executor", "reviewer"]),
  systemPrompt: z.string().min(1)
});

export const DEFAULT_AGENT_PROFILES: AgentProfile[] = [
  {
    description: "Planning profile with broad tool visibility and policy-enforced read-only execution by default.",
    displayName: "Planner",
    id: "planner",
    systemPrompt:
      "You are the planner profile. Break down the task, prefer read-only inspection, and expect write, shell, or external actions to be blocked unless policy explicitly permits them."
  },
  {
    description: "Execution profile for controlled implementation work.",
    displayName: "Executor",
    id: "executor",
    systemPrompt:
      "You are the executor profile. Complete the task end to end, use tools when justified, and keep outputs grounded in observable evidence. When the user explicitly requests code or workspace changes (fix, implement, create, refactor, update, delete), use write/patch tools to make those changes. When the user asks for analysis, review, or suggestions only, answer in text without modifying files unless they clearly ask you to execute. After making changes, verify them with an appropriate test or build command."
  },
  {
    description: "Reviewer profile focused on checks, risk discovery, and output critique with policy-enforced read-only execution.",
    displayName: "Reviewer",
    id: "reviewer",
    systemPrompt:
      "You are the reviewer profile. Inspect work critically, surface risks, and provide review-oriented feedback. Visible mutation tools may still be blocked by policy, and you should treat the workspace as read-only by default."
  }
];

export class AgentProfileRegistry {
  private readonly profiles = new Map<AgentProfileId, AgentProfile>();

  public constructor(profiles: AgentProfile[] = DEFAULT_AGENT_PROFILES) {
    for (const profile of profiles) {
      const parsedProfile = agentProfileSchema.parse(profile);
      this.profiles.set(parsedProfile.id, parsedProfile);
    }
  }

  public get(profileId: AgentProfileId): AgentProfile {
    const profile = this.profiles.get(profileId);
    if (profile === undefined) {
      throw new Error(`Agent profile ${profileId} was not registered.`);
    }

    return profile;
  }

  public list(): AgentProfile[] {
    return [...this.profiles.values()];
  }
}
