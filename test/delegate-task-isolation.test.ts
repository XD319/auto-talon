import { describe, expect, it } from "vitest";

import { isDelegateIsolationEnabled } from "../src/runtime/delegate-isolation.js";
import {
  readSessionResumeMemoryContext,
  readSessionResumeMessages
} from "../src/runtime/kernel-support.js";
import {
  DelegateTaskTool,
  summarizeIsolatedDelegateOutput
} from "../src/tools/delegate-task-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("delegate task isolation", () => {
  it("summarizes isolated delegate output for parent context", () => {
    const summary = summarizeIsolatedDelegateOutput("line one\nline two");
    expect(summary).toContain("[Delegated task summary]");
    expect(summary).toContain("line one");
  });

  it("returns summarized output when isolation is enabled", async () => {
    const tool = new DelegateTaskTool();
    tool.bindExecutor(() =>
      Promise.resolve({
        output: "x".repeat(2_000),
        status: "completed",
        taskId: "child-1"
      })
    );
    const context: ToolExecutionContext = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      taskId: "parent-1",
      userId: "user-1"
    };
    const result = await tool.execute(
      {
        isolation: true,
        prompt: "scan the repo"
      },
      context
    );
    expect(result.success).toBe(true);
    const output = result.output as { isolation: boolean; output: string };
    expect(output.isolation).toBe(true);
    expect(output.output.length).toBeLessThan(2_000);
    expect(output.output).toContain("[Delegated task summary]");
  });

  it("skips session resume injection when delegate isolation is enabled", () => {
    const metadata = {
      delegateIsolation: true,
      sessionResume: {
        contextMessages: [{ content: "resume", role: "user" }],
        memoryContext: [{ memoryId: "m1", text: "memory" }]
      }
    };
    expect(isDelegateIsolationEnabled(metadata)).toBe(true);
    expect(readSessionResumeMessages(metadata)).toEqual([]);
    expect(readSessionResumeMemoryContext(metadata)).toEqual([]);
  });
});
