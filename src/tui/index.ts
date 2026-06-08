import { randomUUID } from "node:crypto";
import React from "react";
import { render } from "ink";

import { createApplication } from "../runtime/index.js";

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
  const handle = createApplication(cwd, {
    scheduler: { autoStart: true },
    ...(options.sandbox !== undefined ? { sandbox: options.sandbox } : {})
  });
  try {
    await handle.service.migrateLegacyTranscripts();

    const ownerUserId = process.env.USERNAME ?? process.env.USER ?? "local-user";
    let initialSessionId = options.resumeSessionId;
    if (options.continueLatest === true) {
      initialSessionId = handle.service.latestSessionIndexForUser(ownerUserId)?.sessionId;
    }
    if (initialSessionId !== undefined && options.resumeSessionId !== undefined && options.continueLatest !== true) {
      const resolved = handle.service.resolveSessionRef(initialSessionId, ownerUserId);
      if (resolved.session !== null) {
        initialSessionId = resolved.session.sessionId;
      }
    }
    if (initialSessionId === undefined) {
      initialSessionId = randomUUID();
    }

    let initialMessages: ChatMessage[] | undefined;
    let initialSessionApprovalFingerprints: string[] | undefined;
    let initialSessionTitle: string | undefined;
    let initialInteractionMode: "agent" | "plan" | undefined;
    let initialRuntimeSessionId: string | undefined;

    const uiState = handle.service.loadSessionUiState(initialSessionId);
    if (uiState !== null) {
      initialMessages = uiState.messages as ChatMessage[];
      initialSessionApprovalFingerprints = uiState.sessionApprovalFingerprints;
      initialInteractionMode = uiState.interactionMode;
      initialRuntimeSessionId = initialSessionId;
      const session = handle.service.findSession(initialSessionId);
      initialSessionTitle = session?.title;
    } else if (options.resumeSessionId !== undefined || options.continueLatest === true) {
      handle.service.ensureRuntimeSession(initialSessionId, {
        cwd,
        ownerUserId,
        title: "Untitled session"
      });
      initialRuntimeSessionId = initialSessionId;
      initialMessages = [
        {
          id: "system:resume-empty",
          kind: "system",
          text: `Session ${initialSessionId.slice(0, 8)} has no saved messages yet.`,
          timestamp: new Date().toISOString()
        }
      ];
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
          initialSessionId,
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
  const handle = createApplication(cwd, {
    scheduler: { autoStart: true },
    ...(sandbox !== undefined ? { sandbox } : {})
  });
  try {
    const app = render(
      React.createElement(AgentTuiApp, {
        queryService: new RuntimeDashboardQueryService(handle.service),
        reviewerId: process.env.USERNAME ?? process.env.USER ?? "local-reviewer"
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
