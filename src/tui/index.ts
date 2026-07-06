import React from "react";
import { render } from "ink";

import { createApplicationAsync } from "../runtime/index.js";
import { resolveDefaultReviewerId, resolveDefaultUserId } from "../runtime/runtime-identity.js";

import { ChatTuiApp } from "./chat-app.js";
import { AgentTuiApp } from "./dashboard-app.js";
import type { TuiResolveAppConfigOptions } from "./runtime-api.js";
import type { ChatMessage } from "./view-models/chat-messages.js";
import { RuntimeDashboardQueryService } from "./view-models/runtime-dashboard.js";

export interface StartTuiOptions {
  continueLatest?: boolean;
  cwd?: string;
  resumeSessionId?: string;
  sandbox?: TuiResolveAppConfigOptions;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const handle = await createApplicationAsync(cwd, {
    scheduler: { autoStart: true },
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {})
  });
  try {
    const ownerUserId = resolveDefaultUserId();
    const requestedRuntimeSession = options.resumeSessionId !== undefined || options.continueLatest === true;
    let initialSessionId = requestedRuntimeSession ? options.resumeSessionId : undefined;
    if (options.continueLatest === true) {
      initialSessionId = handle.service.latestSessionIndexForUser(ownerUserId)?.sessionId;
    }
    if (initialSessionId !== undefined && options.resumeSessionId !== undefined && options.continueLatest !== true) {
      const resolved = handle.service.resolveSessionRef(initialSessionId, ownerUserId);
      if (resolved.session !== null) {
        initialSessionId = resolved.session.sessionId;
      }
    }
    let initialMessages: ChatMessage[] | undefined;
    let initialSessionApprovalFingerprints: string[] | undefined;
    let initialSessionTitle: string | undefined;
    let initialInteractionMode: "agent" | "plan" | "acceptEdits" | undefined;
    let initialRuntimeSessionId: string | undefined;

    const uiState = initialSessionId !== undefined ? handle.service.loadSessionUiState(initialSessionId) : null;
    if (initialSessionId !== undefined && uiState !== null) {
      const runtimeSessionId = initialSessionId;
      initialMessages = uiState.messages as ChatMessage[];
      initialSessionApprovalFingerprints = uiState.sessionApprovalFingerprints;
      initialInteractionMode = uiState.interactionMode;
      initialRuntimeSessionId = runtimeSessionId;
      const session = handle.service.findSession(runtimeSessionId);
      initialSessionTitle = session?.title;
    } else if (requestedRuntimeSession && initialSessionId !== undefined) {
      const runtimeSessionId = initialSessionId;
      handle.service.ensureRuntimeSession(runtimeSessionId, {
        cwd,
        ownerUserId,
        title: "Untitled session"
      });
      initialRuntimeSessionId = runtimeSessionId;
      initialMessages = [
        {
          id: "system:resume-empty",
          kind: "system",
          text: `Session ${runtimeSessionId.slice(0, 8)} has no saved messages yet.`,
          timestamp: new Date().toISOString()
        }
      ];
    } else if (requestedRuntimeSession) {
      initialMessages = [
        {
          id: "system:resume-missing",
          kind: "system",
          text: "No previous session was found. Starting a new session.",
          timestamp: new Date().toISOString()
        }
      ];
    } else {
      initialInteractionMode = handle.config.defaultInteractionMode;
    }

    let app: ReturnType<typeof render> | null = null;
    try {
      app = render(
        React.createElement(ChatTuiApp, {
          config: handle.config,
          cwd,
          ...(initialMessages !== undefined ? { initialMessages } : {}),
          ...(initialSessionApprovalFingerprints !== undefined
            ? { initialSessionApprovalFingerprints }
            : {}),
          ...(initialSessionTitle !== undefined ? { initialSessionTitle } : {}),
          ...(initialInteractionMode !== undefined ? { initialInteractionMode } : {}),
          ...(initialSessionId !== undefined ? { initialSessionId } : {}),
          ...(initialRuntimeSessionId !== undefined ? { initialRuntimeSessionId } : {}),
          reviewerId: ownerUserId,
          service: handle.service
        }),
        {
          alternateScreen: false,
          exitOnCtrlC: false
        }
      );
      await app.waitUntilExit();
    } finally {
      app?.unmount();
    }
  } finally {
    handle.close();
  }
}

export async function startDashboardTui(
  cwd = process.cwd(),
  sandbox?: TuiResolveAppConfigOptions
): Promise<void> {
  const handle = await createApplicationAsync(cwd, {
    scheduler: { autoStart: true },
    ...(sandbox !== undefined ? { sandbox } : {})
  });
  try {
    const app = render(
      React.createElement(AgentTuiApp, {
        queryService: new RuntimeDashboardQueryService(handle.service),
        reviewerId: resolveDefaultReviewerId()
      }),
      {
        alternateScreen: true,
        exitOnCtrlC: false
      }
    );
    await app.waitUntilExit();
    app.unmount();
  } finally {
    handle.close();
  }
}
