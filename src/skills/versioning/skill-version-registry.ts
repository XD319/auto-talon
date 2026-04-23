import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { JsonObject, SkillVersionEntry } from "../../types/index.js";

export interface RecordSkillVersionInput {
  draftId: string;
  skillId: string;
  sourceExperienceIds: string[];
  previousVersion: string | null;
  reason: string;
  metadata?: JsonObject;
}

export interface RecordSkillRollbackInput {
  skillId: string;
  fromVersion: string;
  toVersion: string;
  reason: string;
}

export class SkillVersionRegistry {
  private readonly rootPath: string;

  public constructor(workspaceRoot: string) {
    this.rootPath = resolve(workspaceRoot, ".auto-talon", "skill-versions");
  }

  public recordVersion(input: RecordSkillVersionInput): SkillVersionEntry {
    const existing = this.listVersions(input.skillId);
    const previous = existing.at(-1) ?? null;
    const version = bumpMinorVersion(previous?.version ?? "0.0.0");
    const entry: SkillVersionEntry = {
      action: "promote",
      createdAt: new Date().toISOString(),
      draftId: input.draftId,
      metadata: input.metadata ?? {},
      previousVersion: previous?.version ?? input.previousVersion,
      reason: input.reason,
      skillId: input.skillId,
      sourceExperienceIds: input.sourceExperienceIds,
      version
    };
    this.appendEntry(input.skillId, entry);
    return entry;
  }

  public recordRollback(input: RecordSkillRollbackInput): SkillVersionEntry {
    const entry: SkillVersionEntry = {
      action: "rollback",
      createdAt: new Date().toISOString(),
      draftId: null,
      metadata: {
        fromVersion: input.fromVersion
      },
      previousVersion: input.fromVersion,
      reason: input.reason,
      skillId: input.skillId,
      sourceExperienceIds: [],
      version: input.toVersion
    };
    this.appendEntry(input.skillId, entry);
    return entry;
  }

  public listVersions(skillId: string): SkillVersionEntry[] {
    const filePath = this.filePathForSkill(skillId);
    if (!existsSync(filePath)) {
      return [];
    }
    const lines = readFileSync(filePath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.map((line) => JSON.parse(line) as SkillVersionEntry);
  }

  public currentVersion(skillId: string): SkillVersionEntry | null {
    const versions = this.listVersions(skillId);
    return versions.at(-1) ?? null;
  }

  private appendEntry(skillId: string, entry: SkillVersionEntry): void {
    mkdirSync(this.rootPath, { recursive: true });
    const filePath = this.filePathForSkill(skillId);
    const next = existsSync(filePath) ? `${readFileSync(filePath, "utf8")}${JSON.stringify(entry)}\n` : `${JSON.stringify(entry)}\n`;
    writeFileSync(filePath, next, "utf8");
  }

  private filePathForSkill(skillId: string): string {
    return join(this.rootPath, `${skillId.replace(/[/:]/gu, "__")}.jsonl`);
  }
}

function bumpMinorVersion(version: string): string {
  const [majorRaw, minorRaw] = version.split(".");
  const major = Number.parseInt(majorRaw ?? "0", 10);
  const minor = Number.parseInt(minorRaw ?? "0", 10);
  const safeMajor = Number.isNaN(major) ? 0 : major;
  const safeMinor = Number.isNaN(minor) ? 0 : minor;
  return `${safeMajor}.${safeMinor + 1}.0`;
}
