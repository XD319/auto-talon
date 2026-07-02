import type { TuiInteractionMode } from "../types/index.js";

const INTERACTION_MODE_CYCLE: readonly TuiInteractionMode[] = ["agent", "plan", "acceptEdits"];

export function cycleInteractionMode(current: TuiInteractionMode): TuiInteractionMode {
  const index = INTERACTION_MODE_CYCLE.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + 1) % INTERACTION_MODE_CYCLE.length;
  return INTERACTION_MODE_CYCLE[nextIndex] ?? "agent";
}

export function formatModeChangeMessage(mode: TuiInteractionMode): string {
  if (mode === "plan") {
    return "Mode set to plan. Future prompts are read-only until you switch back with /mode agent or Shift+Tab.";
  }
  if (mode === "acceptEdits") {
    return "Mode set to acceptEdits. Workspace file edits stay allowed; shell and other high-risk tools still require approval.";
  }
  return "Mode set to agent. Future prompts can edit files when the request clearly asks for changes.";
}

export function formatAgentWriteApprovalHelp(
  agentWriteApproval: "off" | "on" | "acceptEditsOnly"
): string {
  if (agentWriteApproval === "on") {
    return "Agent file edits require approval (interactionModes.agentWriteApproval=on).";
  }
  if (agentWriteApproval === "acceptEditsOnly") {
    return "Agent file edits require approval; acceptEdits mode auto-allows file edits.";
  }
  return "Agent file edits in workspace do not require approval by default.";
}
