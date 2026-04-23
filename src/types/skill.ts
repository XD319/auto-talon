import { z } from "zod";

import type { JsonObject } from "./common.js";

export const SKILL_ATTACHMENT_KINDS = [
  "references",
  "templates",
  "scripts",
  "assets"
] as const;

export type SkillAttachmentKind = (typeof SKILL_ATTACHMENT_KINDS)[number];

export const SKILL_SOURCES = ["local", "project", "remote", "draft"] as const;

export type SkillSource = (typeof SKILL_SOURCES)[number];

export const SKILL_PLATFORMS = ["any", "windows", "linux", "darwin"] as const;

export type SkillPlatform = (typeof SKILL_PLATFORMS)[number];

export interface SkillPrerequisites extends JsonObject {
  commands: string[];
  credentials: string[];
  env: string[];
  notes: string[];
}

export interface SkillFrontmatter {
  category: string;
  description: string;
  disabled: boolean;
  metadata: JsonObject;
  name: string;
  namespace: string;
  platforms: SkillPlatform[];
  prerequisites: SkillPrerequisites;
  relatedSkills: string[];
  tags: string[];
  version: string;
}

export interface SkillAttachment {
  kind: SkillAttachmentKind;
  path: string;
}

export interface SkillAttachmentManifest {
  assets: SkillAttachment[];
  references: SkillAttachment[];
  scripts: SkillAttachment[];
  templates: SkillAttachment[];
}

export interface SkillMetadata extends SkillFrontmatter {
  attachmentCounts: Record<SkillAttachmentKind, number>;
  id: string;
  source: SkillSource;
  sourceExperienceIds: string[];
}

export interface SkillAsset {
  attachments: SkillAttachmentManifest;
  body: string;
  metadata: SkillMetadata;
  rootPath: string;
  skillPath: string;
}

export interface SkillView extends SkillAsset {
  loadedAttachments: LoadedSkillAttachment[];
}

export interface LoadedSkillAttachment extends SkillAttachment {
  content: string;
}

export interface SkillRegistryIssue {
  code:
    | "credential_missing"
    | "disabled"
    | "duplicate_shadowed"
    | "invalid_skill"
    | "path_unsafe"
    | "platform_incompatible";
  detail: string;
  path: string;
  skillId: string | null;
}

export interface SkillListResult {
  issues: SkillRegistryIssue[];
  skills: SkillMetadata[];
}

export interface SkillDraftRecord {
  draftId: string;
  draftPath: string;
  rootPath: string;
  sourceExperienceIds: string[];
  targetSkillId: string;
}

export interface SkillCandidateGroup {
  keyword: string;
  reason: string;
  sourceExperienceIds: string[];
  title: string;
}

export interface PromotionGroup {
  key: string;
  scopeKey: string;
  title: string;
  sourceExperienceIds: string[];
  experiences: Array<{
    experienceId: string;
    title: string;
    summary: string;
    content: string;
    status: string;
    sourceType: string;
    keywords: string[];
    keywordPhrases: string[];
    taskStatus: string | null;
    reviewerCount: number;
  }>;
}

export interface PromotionSignals extends JsonObject {
  successCount: number;
  failureCount: number;
  successRate: number;
  stability: number;
  riskLevel: "low" | "medium" | "high";
  humanJudgmentWeight: number;
  reasons: string[];
}

export interface PromotionAdvice extends JsonObject {
  namespace: string;
  skillName: string;
  title: string;
  description: string;
  category: string;
  sourceExperienceIds: string[];
  applicability: string[];
  antiPatterns: string[];
  risks: string[];
  examples: Array<{
    input: string;
    output: string;
  }>;
  rationale: string;
  signals: PromotionSignals;
}

export interface PromotionDecision {
  accepted: boolean;
  advice: PromotionAdvice;
  reason: string;
}

export interface SkillVersionEntry {
  skillId: string;
  action: "promote" | "rollback";
  version: string;
  previousVersion: string | null;
  sourceExperienceIds: string[];
  reason: string;
  draftId: string | null;
  createdAt: string;
  metadata: JsonObject;
}

const jsonObjectSchema = z.record(z.string(), z.json()).transform((value) => value as JsonObject);

export const skillPrerequisitesSchema = z.object({
  commands: z.array(z.string().min(1)),
  credentials: z.array(z.string().min(1)),
  env: z.array(z.string().min(1)),
  notes: z.array(z.string().min(1))
});

export const skillFrontmatterSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  disabled: z.boolean(),
  metadata: jsonObjectSchema,
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/u),
  namespace: z.string().min(1).regex(/^[a-z0-9][a-z0-9_.-]*$/u),
  platforms: z.array(z.enum(SKILL_PLATFORMS)).min(1),
  prerequisites: skillPrerequisitesSchema,
  relatedSkills: z.array(z.string().min(1)),
  tags: z.array(z.string().min(1)),
  version: z.string().min(1)
});

export const skillAttachmentSchema = z.object({
  kind: z.enum(SKILL_ATTACHMENT_KINDS),
  path: z.string().min(1)
});

export const skillAttachmentManifestSchema = z.object({
  assets: z.array(skillAttachmentSchema),
  references: z.array(skillAttachmentSchema),
  scripts: z.array(skillAttachmentSchema),
  templates: z.array(skillAttachmentSchema)
});

export const skillMetadataSchema = skillFrontmatterSchema.extend({
  attachmentCounts: z.object({
    assets: z.number().int().min(0),
    references: z.number().int().min(0),
    scripts: z.number().int().min(0),
    templates: z.number().int().min(0)
  }),
  id: z.string().min(1),
  source: z.enum(SKILL_SOURCES),
  sourceExperienceIds: z.array(z.string().min(1))
});

export const skillAssetSchema = z.object({
  attachments: skillAttachmentManifestSchema,
  body: z.string(),
  metadata: skillMetadataSchema,
  rootPath: z.string().min(1),
  skillPath: z.string().min(1)
});
