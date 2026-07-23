import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatSkillList, formatSkillView } from "../src/cli/formatters.js";
import { createApplication } from "../src/runtime/index.js";
import { RuntimeDashboardQueryService } from "../src/tui/view-models/runtime-dashboard.js";

describe("skill management surface", () => {
  it("surfaces skills through service, formatters, doctor, and dashboard query models", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-surface-"));
    writeProjectSkill(workspaceRoot);
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      }
    });

    try {
      const skills = handle.service.listSkills();
      const listed = formatSkillList(skills);
      expect(listed).toContain("project:team/sqlite_migration");
      expect(listed).toContain("layer=project");
      expect(listed).toContain("required=no");

      const view = formatSkillView(handle.service.viewSkill("project:team/sqlite_migration"));
      expect(view).toContain("Source Experiences: exp-1");
      expect(view).toContain("Layer: project");
      expect(view).toContain("Required: no");

      expect((await handle.service.configDoctor()).skillStats).toMatchObject({
        enabled: 1,
        issues: 0
      });

      const dashboard = new RuntimeDashboardQueryService(handle.service).getDashboard({
        selectedPanel: "skills",
        selectedTaskId: null
      });
      expect(dashboard.skills[0]).toMatchObject({
        id: "project:team/sqlite_migration",
        title: "team/sqlite_migration"
      });

      expect(handle.service.disableSkill("project:team/sqlite_migration").skills).toHaveLength(0);
      expect(handle.service.enableSkill("project:team/sqlite_migration").skills).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it("wires teamRoots through createApplication and blocks disabling required team skills", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-skill-surface-"));
    const teamRoot = await mkdtemp(join(tmpdir(), "auto-talon-team-skills-"));
    writeTeamSkill(teamRoot, "shared/org_rule", {
      description: "Organization enforced coding rule.",
      name: "org_rule",
      namespace: "shared",
      required: true
    });

    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db"),
        skills: {
          builtinRoot: null,
          precedence: ["builtin", "local", "project", "team"],
          teamRoots: [teamRoot]
        }
      }
    });

    try {
      const skills = handle.service.listSkills();
      expect(skills.skills.map((skill) => skill.id)).toContain("team:shared/org_rule");

      const listed = formatSkillList(skills);
      expect(listed).toContain("layer=team");
      expect(listed).toContain("required=yes");

      const view = formatSkillView(handle.service.viewSkill("team:shared/org_rule"));
      expect(view).toContain("Layer: team");
      expect(view).toContain("Required: yes");

      const disableResult = handle.service.disableSkill("team:shared/org_rule");
      expect(disableResult.skills.map((skill) => skill.id)).toContain("team:shared/org_rule");
      expect(disableResult.issues).toContainEqual(
        expect.objectContaining({
          code: "required_locked",
          skillId: "team:shared/org_rule"
        })
      );
    } finally {
      handle.close();
    }
  });
});

function writeProjectSkill(workspaceRoot: string): void {
  writeSkillMarkdown(join(workspaceRoot, ".auto-talon", "skills", "team", "sqlite_migration"), {
    category: "database",
    description: "SQLite migration retry workflow.",
    disabled: false,
    metadata: {
      sourceExperienceIds: ["exp-1"]
    },
    name: "sqlite_migration",
    namespace: "team",
    platforms: ["any"],
    prerequisites: {
      commands: [],
      credentials: [],
      env: [],
      notes: []
    },
    relatedSkills: [],
    required: false,
    tags: ["sqlite", "migration"],
    version: "1.0.0"
  });
}

function writeTeamSkill(
  teamRoot: string,
  relativeSkillRoot: string,
  overrides: {
    description: string;
    name: string;
    namespace: string;
    required: boolean;
  }
): void {
  writeSkillMarkdown(join(teamRoot, ...relativeSkillRoot.split("/")), {
    category: "policy",
    description: overrides.description,
    disabled: false,
    metadata: {
      sourceExperienceIds: ["exp-org"]
    },
    name: overrides.name,
    namespace: overrides.namespace,
    platforms: ["any"],
    prerequisites: {
      commands: [],
      credentials: [],
      env: [],
      notes: []
    },
    relatedSkills: [],
    required: overrides.required,
    tags: ["org"],
    version: "1.0.0"
  });
}

function writeSkillMarkdown(
  skillRoot: string,
  frontmatter: Record<string, unknown>
): void {
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n# Skill\n\nProcedure body`,
    "utf8"
  );
}
