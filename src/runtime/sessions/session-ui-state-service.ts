import { randomUUID } from "node:crypto";

import type {
  JsonObject,
  SessionEntrySource,
  SessionMessageDraft,
  SessionMessageKind,
  SessionMessageRepository,
  SessionRepository,
  SessionUiState
} from "../../types/index.js";
import { readSessionModelSelection } from "../operations/model-selection-service.js";

export interface SessionUiStateServiceDependencies {
  messageRepository: SessionMessageRepository;
  sessionRepository: SessionRepository;
}

export interface SaveSessionUiStateInput {
  entrySource?: SessionEntrySource;
  interactionMode?: "agent" | "plan" | "acceptEdits";
  messages: JsonObject[];
  providerSelection?: string | null;
  sessionApprovalFingerprints?: string[];
  title?: string;
}

export class SessionUiStateService {
  public constructor(private readonly dependencies: SessionUiStateServiceDependencies) {}

  public load(sessionId: string): SessionUiState | null {
    const session = this.dependencies.sessionRepository.findById(sessionId);
    if (session === null) {
      return null;
    }
    const records = this.dependencies.messageRepository.listBySessionId(sessionId);
    return {
      interactionMode: readInteractionMode(session.metadata),
      messages: records.map((record) => record.payload),
      providerSelection: readProviderSelection(session.metadata),
      sessionApprovalFingerprints: readApprovalFingerprints(session.metadata)
    };
  }

  public save(sessionId: string, input: SaveSessionUiStateInput): void {
    const session = this.dependencies.sessionRepository.findById(sessionId);
    if (session === null) {
      return;
    }
    const entrySource = input.entrySource ?? "tui";
    const drafts = input.messages.map((payload) => toMessageDraft(sessionId, payload, entrySource));
    this.dependencies.messageRepository.replaceAll(sessionId, drafts);
    const metadata: JsonObject = {
      ...session.metadata,
      interactionMode: input.interactionMode ?? readInteractionMode(session.metadata),
      ...(input.providerSelection !== undefined
        ? input.providerSelection === null
          ? {}
          : { providerSelection: input.providerSelection }
        : {}),
      sessionApprovalFingerprints: input.sessionApprovalFingerprints ?? readApprovalFingerprints(session.metadata)
    };
    if (input.providerSelection === null) {
      delete metadata.providerSelection;
    }
    const patch: { metadata: JsonObject; title?: string } = { metadata };
    if (input.title !== undefined) {
      patch.title = input.title;
    }
    this.dependencies.sessionRepository.update(sessionId, patch);
  }
}

function toMessageDraft(
  sessionId: string,
  payload: JsonObject,
  entrySource: SessionEntrySource
): SessionMessageDraft {
  const kind = readMessageKind(payload);
  const messageId =
    typeof payload.id === "string" && payload.id.length > 0 ? payload.id : randomUUID();
  const createdAt =
    typeof payload.timestamp === "string" && payload.timestamp.length > 0
      ? payload.timestamp
      : new Date().toISOString();
  return {
    createdAt,
    entrySource,
    kind,
    messageId,
    payload,
    sessionId
  };
}

function readMessageKind(payload: JsonObject): SessionMessageKind {
  const kind = payload.kind;
  if (
    kind === "user" ||
    kind === "agent" ||
    kind === "system" ||
    kind === "activity" ||
    kind === "approval" ||
    kind === "approval_result" ||
    kind === "error"
  ) {
    return kind;
  }
  return "system";
}

function readInteractionMode(metadata: JsonObject): "agent" | "plan" | "acceptEdits" {
  return metadata.interactionMode === "plan"
    ? "plan"
    : metadata.interactionMode === "acceptEdits"
      ? "acceptEdits"
      : "agent";
}

function readApprovalFingerprints(metadata: JsonObject): string[] {
  const value = metadata.sessionApprovalFingerprints;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readProviderSelection(metadata: JsonObject): string | null {
  return readSessionModelSelection(metadata)?.selection ?? null;
}

