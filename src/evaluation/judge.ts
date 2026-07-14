import { createProvider, resolveProviderConfigForProvider } from "../providers/index.js";
import type { ProviderRequest, TaskRecord } from "../types/index.js";
import type { EvalScorerContext } from "./scorers.js";

export function createEvalJudge(cwd: string, providerName: string): NonNullable<EvalScorerContext["judge"]> {
  const config = resolveProviderConfigForProvider(cwd, providerName);
  if (config.configured === false) throw new Error(`Judge provider "${providerName}" is not configured.`);
  const provider = createProvider(config);
  return async ({ output, reference, rubric }) => {
    const task = dummyTask(providerName);
    const request: ProviderRequest = {
      agentProfileId: "reviewer",
      availableTools: [],
      iteration: 1,
      memoryContext: [],
      messages: [
        { role: "system", content: "Grade the answer against the rubric. Return only JSON: {\"passed\":boolean,\"score\":number,\"evidence\":string}. Score must be between 0 and 1." },
        { role: "user", content: `RUBRIC:\n${rubric}\n\nREFERENCE:\n${reference ?? "(none)"}\n\nANSWER:\n${output}` }
      ],
      signal: new AbortController().signal,
      task,
      tokenBudget: { inputLimit: 16_000, outputLimit: 1_000, reservedOutput: 1_000, usedInput: 0, usedOutput: 0 }
    };
    const response = await provider.generate(request);
    if (response.kind !== "final") return { evidence: `judge returned ${response.kind}`, passed: false, score: 0 };
    const parsed = parseJudgeJson(response.message);
    return {
      evidence: parsed.evidence,
      passed: parsed.passed,
      score: Math.max(0, Math.min(1, parsed.score))
    };
  };
}

function parseJudgeJson(message: string): { evidence: string; passed: boolean; score: number } {
  const match = message.match(/\{[\s\S]*\}/u);
  if (match === null) throw new Error("Judge did not return a JSON object.");
  const value = JSON.parse(match[0]) as Record<string, unknown>;
  if (typeof value.passed !== "boolean" || typeof value.score !== "number" || typeof value.evidence !== "string") {
    throw new Error("Judge JSON is missing passed, score, or evidence.");
  }
  return { evidence: value.evidence, passed: value.passed, score: value.score };
}

function dummyTask(providerName: string): TaskRecord {
  const now = new Date().toISOString();
  return {
    agentProfileId: "reviewer",
    createdAt: now,
    currentIteration: 1,
    cwd: process.cwd(),
    errorCode: null,
    errorMessage: null,
    finalOutput: null,
    finishedAt: null,
    input: "Evaluate an agent result.",
    maxIterations: 1,
    metadata: {},
    providerName,
    requesterUserId: "eval-judge",
    startedAt: now,
    status: "running",
    taskId: "eval-judge",
    tokenBudget: { inputLimit: 16_000, outputLimit: 1_000, reservedOutput: 1_000, usedInput: 0, usedOutput: 0 },
    updatedAt: now
  };
}
