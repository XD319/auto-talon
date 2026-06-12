import { describe, expect, it, vi } from "vitest";

import { DelegateTaskTool } from "../src/tools/delegate-task-tool.js";
import type { ToolExecutionContext } from "../src/types/index.js";

describe("DelegateTaskTool", () => {
  it("returns unavailable when no executor is bound", async () => {
    const tool = new DelegateTaskTool();
    const prepared = tool.prepare({ prompt: "Inspect the repo layout" });
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe("tool_unavailable");
    }
  });

  it("delegates to the bound executor and returns child task output", async () => {
    const tool = new DelegateTaskTool();
    const executor = vi.fn(() => Promise.resolve({
      output: "Child finished",
      status: "succeeded",
      taskId: "child-task-1"
    }));
    tool.bindExecutor(executor);

    const prepared = tool.prepare({
      maxIterations: 3,
      profile: "reviewer",
      prompt: "Review the latest changes"
    });
    const result = await tool.execute(prepared.preparedInput, createContext());

    expect(result.success).toBe(true);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        maxIterations: 3,
        parentTaskId: "parent-task-1",
        profile: "reviewer",
        prompt: "Review the latest changes",
        userId: "user-1"
      })
    );
    if (result.success) {
      expect(result.output).toMatchObject({
        output: "Child finished",
        parentTaskId: "parent-task-1",
        status: "succeeded",
        taskId: "child-task-1"
      });
    }
  });
});

function createContext(): ToolExecutionContext {
  return {
    agentProfileId: "executor",
    cwd: process.cwd(),
    iteration: 1,
    signal: new AbortController().signal,
    taskId: "parent-task-1",
    userId: "user-1",
    workspaceRoot: process.cwd()
  };
}
