import { rename, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonObject, SessionRepository } from "../../types/index.js";
import type { SessionUiStateService } from "./session-ui-state-service.js";

export interface PersistedChatSessionFile {
  id: string;
  interactionMode?: "agent" | "plan";
  messages: Array<Record<string, unknown>>;
  sessionApprovalFingerprints?: string[];
  sessionId?: string;
  title?: string;
  updatedAt: string;
}

export interface TranscriptMigrationResult {
  migratedFiles: number;
  skippedFiles: number;
}

export interface TranscriptMigratorDependencies {
  sessionRepository: Pick<SessionRepository, "create" | "findById">;
  sessionUiStateService: SessionUiStateService;
  workspaceRoot: string;
}

export async function migrateLegacyTranscriptFiles(
  dependencies: TranscriptMigratorDependencies
): Promise<TranscriptMigrationResult> {
  const sessionsDir = join(dependencies.workspaceRoot, ".auto-talon", "sessions");
  let entries: string[] = [];
  try {
    entries = await readdir(sessionsDir);
  } catch {
    return { migratedFiles: 0, skippedFiles: 0 };
  }

  let migratedFiles = 0;
  let skippedFiles = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".json.migrated")) {
      continue;
    }
    const path = join(sessionsDir, entry);
    const raw = await readFile(path, "utf8");
    let parsed: PersistedChatSessionFile;
    try {
      parsed = JSON.parse(raw) as PersistedChatSessionFile;
    } catch {
      skippedFiles += 1;
      continue;
    }
    if (typeof parsed.id !== "string" || !Array.isArray(parsed.messages)) {
      skippedFiles += 1;
      continue;
    }

    const sessionId = parsed.sessionId ?? parsed.id;
    ensureSessionRecord(dependencies.sessionRepository, sessionId, parsed);
    dependencies.sessionUiStateService.save(sessionId, {
      entrySource: "migration",
      interactionMode: parsed.interactionMode ?? "agent",
      messages: parsed.messages as JsonObject[],
      sessionApprovalFingerprints: parsed.sessionApprovalFingerprints ?? [],
      ...(parsed.title !== undefined ? { title: parsed.title } : {})
    });
    await rename(path, `${path}.migrated`);
    migratedFiles += 1;
  }

  return { migratedFiles, skippedFiles };
}

function ensureSessionRecord(
  sessionRepository: Pick<SessionRepository, "create" | "findById">,
  sessionId: string,
  parsed: PersistedChatSessionFile
): void {
  const existing = sessionRepository.findById(sessionId);
  if (existing !== null) {
    return;
  }
  sessionRepository.create({
    agentProfileId: "executor",
    cwd: process.cwd(),
    metadata: {
      interactionMode: parsed.interactionMode ?? "agent",
      sessionApprovalFingerprints: parsed.sessionApprovalFingerprints ?? [],
      source: "migration",
      sourceDetail: "legacy-json"
    },
    ownerUserId: process.env.USERNAME ?? process.env.USER ?? "local-user",
    providerName: "unknown",
    sessionId,
    title: parsed.title ?? "Untitled session"
  });
}
