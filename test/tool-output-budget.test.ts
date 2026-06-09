import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { applyToolOutputBudget } from "../src/runtime/context/tool-output-budget.js";

describe("tool-output-budget", () => {
  it("returns content unchanged when under budget", () => {
    const result = applyToolOutputBudget(
      {
        serialized: "small payload",
        taskId: "task-1",
        toolCallId: "tc-1"
      },
      {
        artifactsRoot: mkdtempSync(join(tmpdir(), "talon-artifacts-")),
        maxTokensPerResult: 2_500
      }
    );
    expect(result.content).toBe("small payload");
    expect(result.spilled).toBe(false);
  });

  it("spills oversized output to disk with preview envelope", () => {
    const artifactsRoot = mkdtempSync(join(tmpdir(), "talon-artifacts-"));
    const payload = "x".repeat(20_000);
    const result = applyToolOutputBudget(
      {
        serialized: payload,
        taskId: "task-1",
        toolCallId: "tc-big"
      },
      {
        artifactsRoot,
        maxTokensPerResult: 100
      }
    );
    expect(result.spilled).toBe(true);
    expect(result.artifactPath).toContain("tc-big.txt");
    expect(result.content).toContain("Full tool output saved to:");
    expect(readFileSync(result.artifactPath ?? "", "utf8")).toBe(payload);
  });
});
