import { checkToolAvailability } from "../tools/availability/index.js";
import { evaluateToolExposure } from "../tools/policy/index.js";
import { isPlanSafeTool, resolveToolsetForTool } from "../tools/toolsets.js";
import { TOOLSET_NAMES, type ToolsetName } from "../types/index.js";
import type { ToolOverrideStore } from "../tools/tool-overrides.js";
import type { ToolOrchestrator } from "../tools/tool-orchestrator.js";
import type { TraceService } from "../tracing/trace-service.js";
import type { TuiInteractionMode } from "../types/index.js";
import type { ToolExposurePlan, ToolExecutionContext } from "../types/index.js";
import type { BudgetService } from "./budget/budget-service.js";

export interface ToolExposurePlannerDependencies {
  toolOrchestrator: ToolOrchestrator;
  toolOverrideStore: ToolOverrideStore;
  traceService: TraceService;
  budgetService?: BudgetService;
}

export interface ToolExposurePlannerInput {
  taskId: string;
  sessionId: string | null;
  context: ToolExecutionContext;
  iteration: number;
  interactionMode?: TuiInteractionMode;
}

function isScheduledRunWithoutDelegate(metadata: ToolExecutionContext["taskMetadata"]): boolean {
  const scheduleRunContext = metadata?.scheduleRunContext;
  const hasScheduleRunContext =
    scheduleRunContext !== null &&
    scheduleRunContext !== undefined &&
    typeof scheduleRunContext === "object" &&
    !Array.isArray(scheduleRunContext);
  if (!hasScheduleRunContext) {
    return false;
  }
  return metadata?.allowDelegate !== true;
}

function readScheduleToolsetsFromMetadata(metadata: ToolExecutionContext["taskMetadata"]): {
  requested: boolean;
  toolsets: ToolsetName[];
} {
  const toolsets = metadata?.scheduleToolsets;
  if (!Array.isArray(toolsets)) {
    return { requested: false, toolsets: [] };
  }
  const stringToolsets = toolsets.filter((toolset): toolset is string => typeof toolset === "string");
  const validated = stringToolsets.filter((toolset): toolset is ToolsetName =>
    TOOLSET_NAMES.includes(toolset as ToolsetName)
  );
  return {
    requested: stringToolsets.length > 0,
    toolsets: validated
  };
}

export class ToolExposurePlanner {
  public constructor(private readonly dependencies: ToolExposurePlannerDependencies) {}

  public async plan(input: ToolExposurePlannerInput): Promise<ToolExposurePlan> {
    const disabledToolNames = new Set(this.dependencies.toolOverrideStore.listDisabledToolNames());
    const registeredTools = this.dependencies.toolOrchestrator
      .listToolsWithMetadata()
      .filter((tool) => !disabledToolNames.has(tool.name));
    const scheduleToolsetFilter = readScheduleToolsetsFromMetadata(input.context.taskMetadata);
    let tools =
      input.interactionMode === "plan" ? registeredTools.filter(isPlanSafeTool) : registeredTools;
    if (scheduleToolsetFilter.requested) {
      if (scheduleToolsetFilter.toolsets.length === 0) {
        tools = [];
      } else {
        const allowedToolsets = new Set(scheduleToolsetFilter.toolsets);
        tools = tools.filter((tool) => allowedToolsets.has(resolveToolsetForTool(tool.name)));
      }
    }
    if (isScheduledRunWithoutDelegate(input.context.taskMetadata)) {
      tools = tools.filter((tool) => tool.name !== "delegate_task");
    }
    const availability = await checkToolAvailability(tools, input.context);
    const budgetDowngradeActive =
      this.dependencies.budgetService?.isDowngradeActive("task", input.taskId) === true ||
      (input.sessionId !== null &&
        this.dependencies.budgetService?.isDowngradeActive("session", input.sessionId) === true);
    const decisions = evaluateToolExposure({
      availability,
      budgetDowngradeActive,
      tools
    });
    const exposedNames = decisions.filter((d) => d.exposed).map((d) => d.toolName);
    const exposedTools = this.dependencies.toolOrchestrator.listTools(exposedNames);
    const hiddenTools = decisions.filter((d) => !d.exposed).map((d) => d.toolName);
    const plannerReasons = decisions.map((d) => `${d.toolName}:${d.reason}`);

    if (
      input.iteration === 1 ||
      hiddenTools.length > 0 ||
      decisions.some((decision) => decision.costWarning === true)
    ) {
      this.dependencies.traceService.record({
        actor: "runtime.tool_exposure",
        eventType: "tool_exposure_decided",
        payload: {
          decisions,
          exposedTools: exposedNames,
          hiddenTools,
          interactionMode: input.interactionMode ?? "agent",
          iteration: input.iteration,
          reasons: plannerReasons,
          taskId: input.taskId
        },
        stage: "planning",
        summary: `Tool exposure selected ${exposedNames.length} tools`,
        taskId: input.taskId
      });
    }

    return {
      decisions,
      plannerReasons,
      tools: exposedTools
    };
  }
}
