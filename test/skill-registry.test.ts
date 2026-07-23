import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SkillRegistry } from "../src/skills/index.js";

describe("SkillRegistry", () => {
  it("lists only metadata and views attachments on demand", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const localRoot = mkdtempSync(join(tmpdir(), "auto-talon-local-skills-"));
    writeSkill(workspaceRoot, ".auto-talon/skills/project/demo", {
      name: "demo",
      namespace: "project",
      platforms: ["any"]
    });
    writeFileSync(
      join(workspaceRoot, ".auto-talon/skills/project/demo/references/usage.md"),
      "Use the registry carefully.",
      "utf8"
    );

    const registry = new SkillRegistry({
      localSkillsRoot: localRoot,
      workspaceRoot
    });

    const result = registry.listSkills();
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      attachmentCounts: {
        references: 1
      },
      id: "project:project/demo"
    });
    expect(JSON.stringify(result.skills)).not.toContain("Use the registry carefully.");

    const view = registry.viewSkill("project:project/demo", ["references"]);
    expect(view?.loadedAttachments).toEqual([
      {
        content: "Use the registry carefully.",
        kind: "references",
        path: "references/usage.md"
      }
    ]);
  });

  it("lets project skills shadow local skills by namespace and name", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const localRoot = mkdtempSync(join(tmpdir(), "auto-talon-local-skills-"));
    writeSkill(localRoot, "team/demo", {
      description: "Local copy.",
      name: "demo",
      namespace: "team",
      platforms: ["any"]
    });
    writeSkill(workspaceRoot, ".auto-talon/skills/team/demo", {
      description: "Project copy.",
      name: "demo",
      namespace: "team",
      platforms: ["any"]
    });

    const result = new SkillRegistry({
      localSkillsRoot: localRoot,
      workspaceRoot
    }).listSkills();

    expect(result.skills.map((skill) => skill.id)).toEqual(["project:team/demo"]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "duplicate_shadowed",
        skillId: "local:team/demo"
      })
    );
  });

  it("filters disabled, incompatible, and missing credential skills with issues", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    writeSkill(workspaceRoot, ".auto-talon/skills/project/disabled", {
      disabled: true,
      name: "disabled",
      namespace: "project",
      platforms: ["any"]
    });
    writeSkill(workspaceRoot, ".auto-talon/skills/project/linux_only", {
      name: "linux_only",
      namespace: "project",
      platforms: ["linux"]
    });
    writeSkill(workspaceRoot, ".auto-talon/skills/project/needs_key", {
      name: "needs_key",
      namespace: "project",
      platforms: ["any"],
      prerequisites: {
        commands: [],
        credentials: ["MISSING_API_KEY"],
        env: [],
        notes: []
      }
    });

    const result = new SkillRegistry({
      env: {},
      platform: "win32",
      workspaceRoot
    }).listSkills();

    expect(result.skills).toEqual([]);
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      "credential_missing",
      "disabled",
      "platform_incompatible"
    ]);
  });

  it("enable and disable use overrides without rewriting SKILL.md", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const skillPath = writeSkill(workspaceRoot, ".auto-talon/skills/project/demo", {
      name: "demo",
      namespace: "project",
      platforms: ["any"]
    });
    const before = readSkill(skillPath);
    const registry = new SkillRegistry({
      workspaceRoot
    });

    expect(registry.disableSkill("project:project/demo").skills).toHaveLength(0);
    expect(readSkill(skillPath)).toBe(before);
    expect(registry.enableSkill("project:project/demo").skills).toHaveLength(1);
    expect(readSkill(skillPath)).toBe(before);
  });

  it("lets team skills shadow project skills and refuses to disable required team skills", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const teamRoot = mkdtempSync(join(tmpdir(), "auto-talon-team-skills-"));
    writeSkill(workspaceRoot, ".auto-talon/skills/shared/demo", {
      description: "Project copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"]
    });
    writeSkill(teamRoot, "shared/demo", {
      description: "Team copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"],
      required: true
    });

    const registry = new SkillRegistry({
      teamSkillRoots: [teamRoot],
      workspaceRoot
    });
    const listed = registry.listSkills();
    expect(listed.skills.map((skill) => skill.id)).toEqual(["team:shared/demo"]);
    expect(listed.issues).toContainEqual(
      expect.objectContaining({
        code: "duplicate_shadowed",
        skillId: "project:shared/demo"
      })
    );

    const disableResult = registry.disableSkill("team:shared/demo");
    expect(disableResult.skills.map((skill) => skill.id)).toEqual(["team:shared/demo"]);
    expect(disableResult.issues).toContainEqual(
      expect.objectContaining({
        code: "required_locked",
        skillId: "team:shared/demo"
      })
    );
  });

  it("uses builtin skills as fallback and respects configurable precedence", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const builtinRoot = mkdtempSync(join(tmpdir(), "auto-talon-builtin-skills-"));
    const localRoot = mkdtempSync(join(tmpdir(), "auto-talon-local-skills-"));
    writeSkill(builtinRoot, "core/demo", {
      description: "Builtin copy.",
      name: "demo",
      namespace: "core",
      platforms: ["any"]
    });
    writeSkill(localRoot, "core/demo", {
      description: "Local copy.",
      name: "demo",
      namespace: "core",
      platforms: ["any"]
    });

    const defaultOrder = new SkillRegistry({
      builtinSkillsRoot: builtinRoot,
      localSkillsRoot: localRoot,
      workspaceRoot
    }).listSkills();
    expect(defaultOrder.skills.map((skill) => skill.id)).toEqual(["local:core/demo"]);

    const reversed = new SkillRegistry({
      builtinSkillsRoot: builtinRoot,
      localSkillsRoot: localRoot,
      precedence: ["local", "builtin", "project", "team"],
      workspaceRoot
    }).listSkills();
    expect(reversed.skills.map((skill) => skill.id)).toEqual(["builtin:core/demo"]);
  });

  it("namespaces plugin skills so they do not shadow project skills", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    writeSkill(workspaceRoot, ".auto-talon/skills/shared/demo", {
      description: "Project copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"]
    });
    writeSkill(workspaceRoot, ".auto-talon/plugins/ops/skills/shared/demo", {
      description: "Plugin copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"]
    });

    const result = new SkillRegistry({ workspaceRoot }).listSkills();
    expect(result.skills.map((skill) => skill.id).sort()).toEqual([
      "plugin:ops/shared/demo",
      "project:shared/demo"
    ]);
    expect(result.issues.some((issue) => issue.code === "duplicate_shadowed")).toBe(false);
  });

  it("picks the team winner when the same skill exists in all four layers", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const builtinRoot = mkdtempSync(join(tmpdir(), "auto-talon-builtin-skills-"));
    const localRoot = mkdtempSync(join(tmpdir(), "auto-talon-local-skills-"));
    const teamRoot = mkdtempSync(join(tmpdir(), "auto-talon-team-skills-"));

    writeSkill(builtinRoot, "shared/demo", {
      description: "Builtin copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"]
    });
    writeSkill(localRoot, "shared/demo", {
      description: "Local copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"]
    });
    writeSkill(workspaceRoot, ".auto-talon/skills/shared/demo", {
      description: "Project copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"]
    });
    writeSkill(teamRoot, "shared/demo", {
      description: "Team copy.",
      name: "demo",
      namespace: "shared",
      platforms: ["any"],
      required: true
    });

    const result = new SkillRegistry({
      builtinSkillsRoot: builtinRoot,
      localSkillsRoot: localRoot,
      teamSkillRoots: [teamRoot],
      workspaceRoot
    }).listSkills();

    expect(result.skills.map((skill) => skill.id)).toEqual(["team:shared/demo"]);
    const shadowed = result.issues.filter((issue) => issue.code === "duplicate_shadowed");
    expect(shadowed).toHaveLength(3);
    expect(shadowed.map((issue) => issue.skillId).sort()).toEqual([
      "builtin:shared/demo",
      "local:shared/demo",
      "project:shared/demo"
    ]);
  });

  it("keeps required team skills listed even when override file already disables them", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "auto-talon-skill-registry-"));
    const teamRoot = mkdtempSync(join(tmpdir(), "auto-talon-team-skills-"));
    writeSkill(teamRoot, "shared/org_rule", {
      description: "Org enforced rule.",
      name: "org_rule",
      namespace: "shared",
      platforms: ["any"],
      required: true
    });
    mkdirSync(join(workspaceRoot, ".auto-talon"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".auto-talon", "skill-overrides.json"),
      `${JSON.stringify({ disabledSkillIds: ["team:shared/org_rule"] }, null, 2)}\n`,
      "utf8"
    );

    const result = new SkillRegistry({
      teamSkillRoots: [teamRoot],
      workspaceRoot
    }).listSkills();

    expect(result.skills.map((skill) => skill.id)).toEqual(["team:shared/org_rule"]);
    expect(result.issues.some((issue) => issue.code === "disabled")).toBe(false);
  });
});

function writeSkill(
  root: string,
  relativeSkillRoot: string,
  overrides: Partial<{
    description: string;
    disabled: boolean;
    name: string;
    namespace: string;
    platforms: string[];
    prerequisites: {
      commands: string[];
      credentials: string[];
      env: string[];
      notes: string[];
    };
    required: boolean;
  }>
): string {
  const skillRoot = join(root, ...relativeSkillRoot.split("/"));
  mkdirSync(join(skillRoot, "references"), { recursive: true });
  const frontmatter = {
    category: "testing",
    description: overrides.description ?? "Project copy.",
    disabled: overrides.disabled ?? false,
    metadata: {
      sourceExperienceIds: ["exp-1"]
    },
    name: overrides.name ?? "demo",
    namespace: overrides.namespace ?? "project",
    platforms: overrides.platforms ?? ["any"],
    prerequisites: overrides.prerequisites ?? {
      commands: [],
      credentials: [],
      env: [],
      notes: []
    },
    relatedSkills: [],
    required: overrides.required ?? false,
    tags: ["registry"],
    version: "1.0.0"
  };
  const skillPath = join(skillRoot, "SKILL.md");
  writeFileSync(skillPath, `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# Skill\n`, "utf8");
  return skillPath;
}

function readSkill(path: string): string {
  return readFileSync(path, "utf8");
}
