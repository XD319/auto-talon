import React from "react";

import type { ResolvedProviderConfig } from "../../providers/config.js";
import type { TuiStatusLineConfig } from "../../runtime/tui-status-line-config.js";
import type { TuiInteractionMode } from "../../types/runtime.js";
import type { StatusItem } from "../components/status-bar.js";
import {
  buildStatusLinePayload,
  runStatusLineCommand,
  type StatusLineCommandResult
} from "../status-line-command.js";
import { buildActivityStatusItem, buildBuiltinStatusSegments } from "../status-line-model.js";
import type { TokenHud } from "./use-chat-controller.js";
import type { UiRunState, StatusTone } from "../ui-status.js";
import { readGitBranchStatus } from "../workspace-git-status.js";

export interface UseStatusLineInput {
  activeSessionId: string | null;
  config: TuiStatusLineConfig;
  cwd: string;
  inputLimit: number;
  interactionMode: TuiInteractionMode;
  pendingApprovalToolName: string | null;
  pendingClarify: boolean;
  primaryLabel: string;
  primaryTone: StatusTone;
  provider: ResolvedProviderConfig;
  renderWidthChars: number;
  reservedOutput: number;
  runState: UiRunState;
  tokenHud: TokenHud;
}

export interface StatusLineView {
  activity: StatusItem | null;
  commandError: boolean;
  hidden: boolean;
  padding: number;
  sessionSegments: StatusItem[];
}

export function useStatusLine(input: UseStatusLineInput): StatusLineView {
  const gitStatus = React.useMemo(() => readGitBranchStatus(input.cwd), [input.cwd, input.runState, input.tokenHud.contextPercent]);

  const activity = React.useMemo(
    () =>
      buildActivityStatusItem({
        pendingApprovalToolName: input.pendingApprovalToolName,
        pendingClarify: input.pendingClarify,
        primaryLabel: input.primaryLabel,
        primaryTone: input.primaryTone,
        runState: input.runState
      }),
    [
      input.pendingApprovalToolName,
      input.pendingClarify,
      input.primaryLabel,
      input.primaryTone,
      input.runState
    ]
  );

  const hidden = input.config.style === "hidden";
  const [commandState, setCommandState] = React.useState<{
    error: boolean;
    text: string | null;
  }>({ error: false, text: null });

  const payload = React.useMemo(
    () =>
      buildStatusLinePayload({
        cwd: input.cwd,
        gitStatus,
        inputLimit: input.inputLimit,
        interactionMode: input.interactionMode,
        provider: input.provider,
        renderWidthChars: input.renderWidthChars,
        reservedOutput: input.reservedOutput,
        runState: input.runState,
        sessionId: input.activeSessionId,
        tokenHud: input.tokenHud
      }),
    [
      gitStatus,
      input.activeSessionId,
      input.cwd,
      input.inputLimit,
      input.interactionMode,
      input.provider,
      input.renderWidthChars,
      input.reservedOutput,
      input.runState,
      input.tokenHud
    ]
  );

  React.useEffect(() => {
    if (hidden || input.config.type !== "command" || (input.config.command?.trim().length ?? 0) === 0) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const run = async (): Promise<void> => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const result: StatusLineCommandResult = await runStatusLineCommand(input.config, payload);
        if (cancelled) {
          return;
        }
        if (result.ok && result.text !== null) {
          setCommandState({ error: false, text: result.text });
          return;
        }
        if (result.error === "throttled") {
          return;
        }
        setCommandState({ error: true, text: null });
      } finally {
        inFlight = false;
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, Math.max(300, input.config.updateIntervalMs));

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [hidden, input.config, payload]);

  const builtinSegments = React.useMemo(
    () =>
      buildBuiltinStatusSegments({
        config: input.config,
        gitStatus,
        inputLimit: input.inputLimit,
        interactionMode: input.interactionMode,
        provider: input.provider,
        reservedOutput: input.reservedOutput,
        tokenHud: input.tokenHud
      }),
    [
      gitStatus,
      input.config,
      input.inputLimit,
      input.interactionMode,
      input.provider,
      input.reservedOutput,
      input.tokenHud
    ]
  );

  if (hidden) {
    return {
      activity: null,
      commandError: false,
      hidden: true,
      padding: input.config.padding,
      sessionSegments: []
    };
  }

  if (input.config.type === "command") {
    return {
      activity,
      commandError: commandState.error,
      hidden: false,
      padding: input.config.padding,
      sessionSegments:
        commandState.error
          ? [{ label: "status line error", tone: "muted" }]
          : commandState.text !== null
            ? [{ label: commandState.text, tone: "muted" }]
            : []
    };
  }

  return {
    activity,
    commandError: false,
    hidden: false,
    padding: input.config.padding,
    sessionSegments: builtinSegments
  };
}
