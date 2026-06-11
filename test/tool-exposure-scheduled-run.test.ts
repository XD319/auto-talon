import { describe, expect, it, vi } from "vitest";

import { ToolExposurePlanner } from "../src/runtime/tool-exposure-planner.js";
import type { ToolOrchestrator } from "../src/tools/tool-orchestrator.js";
import type { ToolOverrideStore } from "../src/tools/tool-overrides.js";
import type { TraceService } from "../src/tracing/trace-service.js";

describe("ToolExposurePlanner scheduled runs", () => {
  it("hides delegate_task during scheduled runs unless allowDelegate is set", async () => {
    const tools = [
      { name: "delegate_task", description: "delegate", inputSchema: {} },
      { name: "read", description: "read", inputSchema: {} }
    ];
    const orchestrator = {
      listToolsWithMetadata: () => tools,
      listTools: (names: string[]) => tools.filter((tool) => names.includes(tool.name))
    } as unknown as ToolOrchestrator;
    const planner = new ToolExposurePlanner({
      toolOrchestrator: orchestrator,
      toolOverrideStore: { listDisabledToolNames: () => [] } as ToolOverrideStore,
      traceService: { record: vi.fn() } as unknown as TraceService
    });

    const blocked = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        taskMetadata: {
          scheduleRunContext: { disallowScheduleManagement: true, runId: "run-1", scheduleId: "sched-1" }
        },
        userId: "local-user"
      },
      iteration: 1,
      sessionId: null,
      taskId: "task-1"
    });
    expect(blocked.tools.map((tool) => tool.name)).toEqual(["read"]);

    const allowed = await planner.plan({
      context: {
        agentProfileId: "executor",
        cwd: process.cwd(),
        taskMetadata: {
          allowDelegate: true,
          scheduleRunContext: { disallowScheduleManagement: true, runId: "run-1", scheduleId: "sched-1" }
        },
        userId: "local-user"
      },
      iteration: 1,
      sessionId: null,
      taskId: "task-2"
    });
    expect(allowed.tools.map((tool) => tool.name)).toEqual(["delegate_task", "read"]);
  });
});
