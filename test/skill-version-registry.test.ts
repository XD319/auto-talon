import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { SkillVersionRegistry } from "../src/skills/versioning/skill-version-registry.js";

describe("skill version registry", () => {
  it("bumps versions and records rollbacks", () => {
    const workspace = mkdtempSync(join(tmpdir(), "skill-version-registry-"));
    try {
      const registry = new SkillVersionRegistry(workspace);
      const skillId = "project:experience/retry_flaky_tests";
      const first = registry.recordVersion({
        draftId: "draft-1",
        previousVersion: null,
        reason: "initial promotion",
        skillId,
        sourceExperienceIds: ["exp-1"]
      });
      const second = registry.recordVersion({
        draftId: "draft-2",
        previousVersion: first.version,
        reason: "second promotion",
        skillId,
        sourceExperienceIds: ["exp-2"]
      });
      const rollback = registry.recordRollback({
        fromVersion: second.version,
        reason: "rollback requested",
        skillId,
        toVersion: first.version
      });
      expect(first.version).toBe("0.1.0");
      expect(second.version).toBe("0.2.0");
      expect(rollback.action).toBe("rollback");
      const versions = registry.listVersions(skillId);
      expect(versions).toHaveLength(3);
      expect(registry.currentVersion(skillId)?.action).toBe("rollback");
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
