import { z } from "zod";

import type { SkillRegistry } from "../skills/index.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolPreparation
} from "../types/index.js";

const skillsListSchema = z.object({});

export class SkillsListTool implements ToolDefinition<typeof skillsListSchema, Record<string, never>> {
  public readonly name = "skills_list";
  public readonly description = "List available skills with metadata for follow-up skill_view reads.";
  public readonly capability = "filesystem.read" as const;
  public readonly riskLevel = "low" as const;
  public readonly privacyLevel = "internal" as const;
  public readonly costLevel = "free" as const;
  public readonly sideEffectLevel = "read_only" as const;
  public readonly approvalDefault = "never" as const;
  public readonly toolKind = "runtime_primitive" as const;
  public readonly inputSchema = skillsListSchema;

  public constructor(private readonly registry: SkillRegistry) {}

  public prepare(
    input: unknown,
    context: ToolExecutionContext
  ): ToolPreparation<Record<string, never>> {
    this.inputSchema.parse(input);
    return {
      governance: {
        pathScope: "workspace",
        summary: "List available skills"
      },
      preparedInput: {},
      sandbox: {
        kind: "file",
        operation: "read",
        pathScope: "workspace",
        requestedPath: ".auto-talon/skills",
        resolvedPath: context.workspaceRoot,
        withinExtraWriteRoot: false
      }
    };
  }

  public execute(): Promise<ToolExecutionResult> {
    const result = this.registry.listSkills();
    return Promise.resolve({
      output: JSON.parse(
        JSON.stringify({
          issues: result.issues,
          skills: result.skills
        })
      ),
      success: true,
      summary: `Listed ${result.skills.length} skill(s).`
    });
  }
}
