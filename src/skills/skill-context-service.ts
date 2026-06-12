import { randomUUID } from "node:crypto";

import { tokenize, uniqueStrings } from "../recall/recall-engine.js";
import type { SkillRegistry } from "./skill-registry.js";
import type { ContextFragment, SkillMetadata, TaskRecord } from "../types/index.js";

export interface SkillContextServiceOptions {
  limit?: number;
  maxMetadataChars?: number;
  registry: SkillRegistry;
}

interface RankedSkill {
  metadata: SkillMetadata;
  score: number;
}

export interface ExplicitSkillActivation {
  agent: string | null;
  allowedTools: string[];
  arguments: string;
  context: string | null;
  disallowedTools: string[];
  skillId: string;
}

export class SkillContextService {
  private readonly limit: number;
  private readonly maxMetadataChars: number;

  public constructor(private readonly options: SkillContextServiceOptions) {
    this.limit = options.limit ?? 5;
    this.maxMetadataChars = options.maxMetadataChars ?? 8_000;
  }

  public buildContext(task: TaskRecord): ContextFragment[] {
    const explicit = this.buildExplicitSkillContext(task);
    const fragments: ContextFragment[] = [...explicit];
    let usedChars = explicit.reduce((sum, fragment) => sum + fragment.text.length, 0);
    for (const candidate of this.rankSkills(task).slice(0, this.limit)) {
      const fragment = toContextFragment(candidate.metadata, candidate.score);
      const remaining = this.maxMetadataChars - usedChars;
      if (remaining <= 0) {
        break;
      }
      if (fragment.text.length > remaining) {
        fragment.text = `${fragment.text.slice(0, Math.max(0, remaining - 24))}\n[skill metadata truncated]`;
      }
      usedChars += fragment.text.length;
      fragments.push(fragment);
    }
    return fragments;
  }

  public rankSkills(task: Pick<TaskRecord, "cwd" | "input">): RankedSkill[] {
    const queryTokens = tokenize(`${task.input} ${task.cwd}`);
    if (queryTokens.length === 0) {
      return [];
    }

    return this.options.registry
      .listSkills()
      .skills.map((metadata) => ({
        metadata,
        score: scoreSkill(metadata, queryTokens)
      }))
      .filter((candidate) => allowsImplicitInvocation(candidate.metadata))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.metadata.id.localeCompare(right.metadata.id));
  }

  public resolveExplicitSkillActivations(input: string): ExplicitSkillActivation[] {
    const invocations = parseExplicitSkillInvocations(input);
    if (invocations.length === 0) {
      return [];
    }
    const skills = this.options.registry.listSkills().skills;
    return invocations.flatMap((invocation) => {
      const metadata = findSkillByRef(skills, invocation.skillRef);
      if (metadata === undefined) {
        return [];
      }
      return [
        {
          agent: readOptionalString(metadata.metadata.agent),
          allowedTools: readStringArray(metadata.metadata["allowed-tools"]),
          arguments: invocation.arguments,
          context: readOptionalString(metadata.metadata.context),
          disallowedTools: readStringArray(metadata.metadata["disallowed-tools"]),
          skillId: metadata.id
        }
      ];
    });
  }

  private buildExplicitSkillContext(task: TaskRecord): ContextFragment[] {
    const invocations = parseExplicitSkillInvocations(task.input);
    if (invocations.length === 0) {
      return [];
    }
    const skills = this.options.registry.listSkills().skills;
    return invocations.flatMap((invocation) => {
      const metadata = findSkillByRef(skills, invocation.skillRef);
      if (metadata === undefined) {
        return [];
      }
      const view = this.options.registry.viewSkill(metadata.id, []);
      if (view === null) {
        return [];
      }
      return [
        {
          confidence: 1,
          explanation: `explicit skill invocation ${invocation.skillRef}`,
          fragmentId: randomUUID(),
          memoryId: `skill:${metadata.id}:explicit`,
          privacyLevel: "internal",
          retentionPolicy: {
            kind: "working",
            reason: "Explicitly invoked skill loaded for this task.",
            ttlDays: null
          },
          scope: "skill_ref",
          sourceType: "system",
          status: "verified",
          text: [
            `Explicit skill: ${metadata.id}`,
            ...formatExplicitSkillRouting(metadata),
            applySkillArguments(view.body, invocation.arguments)
          ].join("\n"),
          title: `Skill ${metadata.id}`
        } satisfies ContextFragment
      ];
    });
  }
}

function findSkillByRef(skills: SkillMetadata[], skillRef: string): SkillMetadata | undefined {
  return skills.find(
    (skill) =>
      skill.id === skillRef ||
      skill.name === skillRef ||
      `${skill.namespace}/${skill.name}` === skillRef ||
      `${skill.source}:${skill.namespace}/${skill.name}` === skillRef
  );
}

function scoreSkill(metadata: SkillMetadata, queryTokens: string[]): number {
  const skillTokens = uniqueStrings(
    tokenize(
      [
        metadata.id,
        metadata.name,
        metadata.namespace,
        metadata.category,
        metadata.description,
        ...metadata.tags,
        ...metadata.relatedSkills
      ].join(" ")
    )
  );
  const query = new Set(queryTokens);
  const overlap = skillTokens.filter((token) => query.has(token)).length;
  return overlap / Math.max(1, Math.min(skillTokens.length, query.size));
}

function toContextFragment(metadata: SkillMetadata, score: number): ContextFragment {
  return {
    confidence: Number(score.toFixed(4)),
    explanation: `skill metadata matched task with score=${score.toFixed(2)}; full content requires skill_view`,
    fragmentId: randomUUID(),
    memoryId: `skill:${metadata.id}`,
    privacyLevel: "internal",
    retentionPolicy: {
      kind: "working",
      reason: "Skill metadata is loaded only for the active task.",
      ttlDays: null
    },
    scope: "skill_ref",
    sourceType: "system",
    status: "verified",
    text: [
      `Relevant skill metadata: ${metadata.id}`,
      `description=${metadata.description}`,
      `category=${metadata.category}`,
      `tags=${metadata.tags.join(",") || "-"}`,
      `attachments references=${metadata.attachmentCounts.references} templates=${metadata.attachmentCounts.templates} scripts=${metadata.attachmentCounts.scripts} assets=${metadata.attachmentCounts.assets}`,
      "Use skill_view with this id only if the full skill body or attachments are necessary."
    ].join("\n"),
    title: `Skill ${metadata.id}`
  };
}

function allowsImplicitInvocation(metadata: SkillMetadata): boolean {
  if (metadata.metadata["disable-model-invocation"] === true) {
    return false;
  }
  if (metadata.metadata.allow_implicit_invocation === false) {
    return false;
  }
  return true;
}

function formatExplicitSkillRouting(metadata: SkillMetadata): string[] {
  const context = readOptionalString(metadata.metadata.context);
  const agent = readOptionalString(metadata.metadata.agent);
  if (context !== "fork" || agent === null) {
    return [];
  }
  return [`Routing: use delegate_task with agent profile "${agent}" for this forked skill.`];
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseExplicitSkillInvocations(input: string): Array<{ skillRef: string; arguments: string }> {
  const invocations: Array<{ skillRef: string; arguments: string }> = [];
  const pattern = /\$([A-Za-z0-9:_./-]+)(?:\s+([^\n]+))?/gu;
  for (const match of input.matchAll(pattern)) {
    const skillRef = match[1];
    if (skillRef === undefined) {
      continue;
    }
    invocations.push({
      arguments: match[2]?.trim() ?? "",
      skillRef
    });
  }
  return invocations;
}

function applySkillArguments(body: string, args: string): string {
  const parts = args.length === 0 ? [] : args.split(/\s+/u);
  let output = body.replaceAll("$ARGUMENTS", args).replaceAll("$0", args);
  parts.forEach((part, index) => {
    output = output.replaceAll(`$${index + 1}`, part);
  });
  return output;
}
