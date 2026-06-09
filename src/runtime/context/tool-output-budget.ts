import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clipFileContent } from "./recent-file-reads.js";
import { estimateMessageTokens } from "./token-counter.js";

export interface ToolOutputBudgetConfig {
  artifactsRoot: string;
  maxTokensPerResult: number;
}

export interface ToolOutputBudgetInput {
  serialized: string;
  taskId: string;
  toolCallId: string;
}

export interface ToolOutputBudgetResult {
  artifactPath: string | null;
  content: string;
  spilled: boolean;
  truncated: boolean;
}

export const DEFAULT_TOOL_OUTPUT_MAX_TOKENS = 2_500;

export function applyToolOutputBudget(
  input: ToolOutputBudgetInput,
  config: ToolOutputBudgetConfig
): ToolOutputBudgetResult {
  const originalTokens = estimateMessageTokens(input.serialized);
  if (originalTokens <= config.maxTokensPerResult) {
    return {
      artifactPath: null,
      content: input.serialized,
      spilled: false,
      truncated: false
    };
  }

  const artifactDir = join(config.artifactsRoot, input.taskId);
  const artifactPath = join(artifactDir, `${sanitizeArtifactName(input.toolCallId)}.txt`);
  try {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(artifactPath, input.serialized, "utf8");
    return {
      artifactPath,
      content: buildSpillEnvelope(
        input.serialized,
        artifactPath,
        originalTokens,
        config.maxTokensPerResult
      ),
      spilled: true,
      truncated: false
    };
  } catch {
    const maxBytes = Math.max(256, Math.floor((config.maxTokensPerResult * 4) / 1.33));
    const { content, truncated } = clipFileContent(input.serialized, maxBytes);
    return {
      artifactPath: null,
      content: buildTruncateEnvelope(content, originalTokens, truncated),
      spilled: false,
      truncated: true
    };
  }
}

function sanitizeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, "_");
}

function buildSpillEnvelope(
  full: string,
  path: string,
  originalTokens: number,
  maxTokens: number
): string {
  const footer = `\n\nFull tool output saved to: ${path}\n(original ~${originalTokens} tokens; inline preview capped at ~${maxTokens} tokens)`;
  const previewBudget = Math.max(100, maxTokens - estimateMessageTokens(footer));
  const maxBytes = Math.max(256, Math.floor((previewBudget * 4) / 1.33));
  const { content: preview } = clipFileContent(full, maxBytes);
  return `${preview}${footer}`;
}

function buildTruncateEnvelope(content: string, originalTokens: number, truncated: boolean): string {
  if (!truncated) {
    return content;
  }
  return `${content}\n\n[tool output truncated: ~${originalTokens} tokens; re-invoke tool for full result]`;
}
