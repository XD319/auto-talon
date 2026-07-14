import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

const baseScorerSchema = z.object({
  id: z.string().min(1),
  required: z.boolean().default(true),
  weight: z.number().positive().default(1)
});

const fileStateScorerSchema = baseScorerSchema.extend({
  type: z.literal("file_state"),
  path: z.string().min(1),
  exists: z.boolean().default(true),
  contains: z.array(z.string()).default([]),
  notContains: z.array(z.string()).default([])
});

const commandScorerSchema = baseScorerSchema.extend({
  type: z.literal("command"),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000).default(30_000),
  hiddenFiles: z.record(z.string(), z.string()).default({}),
  expectedExitCode: z.number().int().default(0),
  outputContains: z.array(z.string()).default([])
});

const diffScorerSchema = baseScorerSchema.extend({
  type: z.literal("workspace_diff"),
  allowedPaths: z.array(z.string().min(1)).min(1),
  requiredPaths: z.array(z.string().min(1)).default([]),
  requireChanges: z.boolean().default(true)
});

const outputScorerSchema = baseScorerSchema.extend({
  type: z.literal("output"),
  contains: z.array(z.string()).default([]),
  notContains: z.array(z.string()).default([]),
  minLength: z.number().int().nonnegative().default(0)
});

const toolScorerSchema = baseScorerSchema.extend({
  type: z.literal("tool_trace"),
  requiredTools: z.array(z.string().min(1)).default([]),
  forbiddenTools: z.array(z.string().min(1)).default([]),
  requiredArguments: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  maxCalls: z.number().int().nonnegative().optional()
});

const traceScorerSchema = baseScorerSchema.extend({
  type: z.literal("trace"),
  requiredEvents: z.array(z.string().min(1)).default([]),
  forbiddenEvents: z.array(z.string().min(1)).default([])
});

const llmJudgeScorerSchema = baseScorerSchema.extend({
  type: z.literal("llm_judge"),
  required: z.literal(false).default(false),
  rubric: z.string().min(1),
  reference: z.string().optional()
});

export const evalScorerSchema = z.discriminatedUnion("type", [
  fileStateScorerSchema,
  commandScorerSchema,
  diffScorerSchema,
  outputScorerSchema,
  toolScorerSchema,
  traceScorerSchema,
  llmJudgeScorerSchema
]);

export type EvalScorer = z.infer<typeof evalScorerSchema>;

const evalTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  input: z.string().min(1),
  profile: z.enum(["executor", "planner", "reviewer"]).default("executor"),
  category: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  capabilities: z.array(z.string().min(1)).min(1),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
  approvalMode: z.enum(["allow", "deny"]).default("allow"),
  workspace: z.object({
    files: z.record(z.string(), z.string()).default({})
  }).strict().default({ files: {} }),
  scorers: z.array(evalScorerSchema).min(1)
}).strict().superRefine((task, context) => {
  if (!task.scorers.some((scorer) => scorer.type !== "llm_judge" && scorer.required)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Each eval task requires at least one deterministic required scorer.",
      path: ["scorers"]
    });
  }
  const ids = task.scorers.map((scorer) => scorer.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Scorer ids must be unique within a task.",
      path: ["scorers"]
    });
  }
});

export type EvalTask = z.infer<typeof evalTaskSchema>;

export const evalSuiteManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  promptVersion: z.string().min(1).default("runtime-default"),
  toolSchemaVersion: z.string().min(1).default("runtime-default"),
  tasks: z.array(evalTaskSchema).min(1)
}).strict().superRefine((suite, context) => {
  const ids = suite.tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Eval task ids must be unique.",
      path: ["tasks"]
    });
  }
});

export type EvalSuiteManifest = z.infer<typeof evalSuiteManifestSchema>;

export function loadEvalSuite(path: string): EvalSuiteManifest {
  const absolutePath = resolve(path);
  return evalSuiteManifestSchema.parse(JSON.parse(readFileSync(absolutePath, "utf8")));
}
