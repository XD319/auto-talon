import { resolveSessionRef } from "../runtime/sessions/session-resolver.js";
import type { SessionIndexEntry, SessionRecord } from "../types/index.js";

export interface GatewayResumeSessionOperations {
  findSession: (sessionId: string) => SessionRecord | null;
  listSessionIndex: (query: { ownerUserId?: string; status?: "active" | "archived" | "deleted" }) => SessionIndexEntry[];
  listSessions: () => SessionRecord[];
  rebindGatewaySession: (input: {
    adapterId: string;
    externalSessionId: string;
    externalUserId: string | null;
    ownerUserId: string;
    runtimeSessionId: string;
    runtimeUserId: string;
  }) => { resumeHint: string };
  resolveGatewayRuntimeSessionId: (adapterId: string, externalSessionId: string) => string | null;
  getLongTermMemoryStatus: (cwd: string) => { enabled: boolean; configPath: string };
  setLongTermMemoryEnabled: (cwd: string, enabled: boolean) => { enabled: boolean; configPath: string };
}

export interface GatewayResumeCommandInput {
  adapterId: string;
  externalSessionId: string;
  externalUserId: string | null;
  ownerUserId: string;
  runtimeUserId: string;
  sessions: GatewayResumeSessionOperations;
  taskInput: string;
  cwd: string;
}

export interface GatewayResumeCommandResult {
  handled: true;
  message: string;
}

export function tryHandleGatewayResumeCommand(
  input: GatewayResumeCommandInput
): GatewayResumeCommandResult | { handled: false } {
  const trimmed = input.taskInput.trim();
  const parts = trimmed.split(/\s+/u);
  const command = parts[0] ?? "";
  if (command === "/memory" && ["on", "off", "status"].includes(parts[1] ?? "")) {
    const action = parts[1] ?? "status";
    const status = action === "status"
      ? input.sessions.getLongTermMemoryStatus(input.cwd)
      : input.sessions.setLongTermMemoryEnabled(input.cwd, action === "on");
    return { handled: true, message: `Long-term memory: ${status.enabled ? "on" : "off"}` };
  }
  if (command !== "/sessions" && command !== "/resume") {
    return { handled: false };
  }

  if (command === "/sessions") {
    const entries = input.sessions
      .listSessionIndex({ ownerUserId: input.ownerUserId, status: "active" })
      .slice(0, 12);
    const activeRuntimeSessionId = input.sessions.resolveGatewayRuntimeSessionId(
      input.adapterId,
      input.externalSessionId
    );
    const activeSession = activeRuntimeSessionId === null ? null : input.sessions.findSession(activeRuntimeSessionId);
    const activeLine =
      activeRuntimeSessionId === null
        ? "Active session: none"
        : `Active session: ${activeRuntimeSessionId.slice(0, 8)}${activeSession !== null ? ` | ${activeSession.title}` : ""}`;
    if (entries.length === 0) {
      return { handled: true, message: `${activeLine}\nNo active sessions.` };
    }
    return {
      handled: true,
      message: [
        activeLine,
        ...entries.map(
          (entry) =>
            `- ${entry.sessionId.slice(0, 8)} | ${entry.title} | ${entry.messageCount} msgs${entry.preview !== null ? ` | ${entry.preview}` : ""}`
        )
      ].join("\n")
    };
  }

  if (command === "/resume") {
    const prefix = parts.slice(1).join(" ").trim();
    if (prefix.length === 0) {
      return { handled: true, message: "Usage: /resume <session-id-prefix-or-title>. Use /sessions to browse." };
    }
    const resolved = resolveSessionRef(prefix, input.ownerUserId, input.sessions.listSessions());
    if (resolved.session === null) {
      if (resolved.ambiguous.length > 0) {
        return {
          handled: true,
          message: `Ambiguous session prefix '${prefix}':\n${resolved.ambiguous
            .map((session) => `- ${session.sessionId.slice(0, 8)} | ${session.title}`)
            .join("\n")}`
        };
      }
      return { handled: true, message: `No session matched prefix '${prefix}'.` };
    }
    const result = input.sessions.rebindGatewaySession({
      adapterId: input.adapterId,
      externalSessionId: input.externalSessionId,
      externalUserId: input.externalUserId,
      ownerUserId: input.ownerUserId,
      runtimeSessionId: resolved.session.sessionId,
      runtimeUserId: input.runtimeUserId
    });
    return {
      handled: true,
      message: `Resumed session ${resolved.session.sessionId.slice(0, 8)} | ${resolved.session.title}\nResume locally: ${result.resumeHint}`
    };
  }

  return { handled: false };
}
