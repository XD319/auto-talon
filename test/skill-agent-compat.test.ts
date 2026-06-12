import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SkillContextService, SkillRegistry } from "../src/skills/index.js";
import type { TaskRecord } from "../src/types/index.js";

describe("Agent Skills compatibility", () => {
  it("loads minimal one-level .agents skills and explicit invocations with arguments", () => {
    const workspace = mkdtempSync(join(tmpdir(), "auto-talon-agent-skills-"));
    const skillRoot = join(workspace, ".agents", "skills", "release-notes");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      [
        "---",
        "name: release-notes",
        "description: Draft release notes for $ARGUMENTS.",
        "disable-model-invocation: true",
        "allowed-tools: [\"read_file\", \"delegate_task\"]",
        "disallowed-tools: [\"shell\"]",
        "context: fork",
        "agent: release-writer",
        "---",
        "Write release notes for $ARGUMENTS using first arg $1."
      ].join("\n"),
      "utf8"
    );

    const registry = new SkillRegistry({ workspaceRoot: workspace });
    const list = registry.listSkills();
    expect(list.skills[0]).toMatchObject({
      id: "project:default/release-notes",
      name: "release-notes",
      namespace: "default"
    });

    const service = new SkillContextService({ registry });
    expect(service.buildContext(task("please draft release notes"))).toHaveLength(0);
    const explicit = service.buildContext(task("$release-notes v1.2.3"));
    expect(explicit).toHaveLength(1);
    expect(explicit[0]?.text).toContain("use delegate_task with agent profile \"release-writer\"");
    expect(explicit[0]?.text).toContain("Write release notes for v1.2.3 using first arg v1.2.3.");
    expect(service.resolveExplicitSkillActivations("$release-notes v1.2.3")).toEqual([
      {
        agent: "release-writer",
        allowedTools: ["read_file", "delegate_task"],
        arguments: "v1.2.3",
        context: "fork",
        disallowedTools: ["shell"],
        skillId: "project:default/release-notes"
      }
    ]);
  });
});

function task(input: string): TaskRecord {
  return {
    agentProfileId: "executor",
    completedAt: null,
    createdAt: new Date().toISOString(),
    currentIteration: 0,
    cwd: process.cwd(),
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input,
    maxIterations: 1,
    metadata: {},
    providerName: "mock",
    requesterUserId: "local-user",
    sessionId: null,
    startedAt: null,
    status: "pending",
    taskId: "task-1",
    tokenBudget: {
      inputLimit: 1000,
      outputLimit: 1000,
      reservedOutput: 100,
      usedCostUsd: 0,
      usedInput: 0,
      usedOutput: 0
    },
    updatedAt: new Date().toISOString()
  };
}
