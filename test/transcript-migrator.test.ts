import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { migrateLegacyTranscriptFiles } from "../src/runtime/sessions/transcript-migrator.js";
import { SessionUiStateService } from "../src/runtime/sessions/session-ui-state-service.js";

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await import("node:fs/promises").then((fs) => fs.rm(tempPath, { force: true, recursive: true }));
    }
  }
});

describe("transcript migrator", () => {
  it("migrates legacy JSON transcripts into SQLite and renames files", async () => {
    const workspaceRoot = await import("node:fs/promises").then((fs) =>
      fs.mkdtemp(join(tmpdir(), "auto-talon-transcript-migrator-"))
    );
    tempPaths.push(workspaceRoot);
    const sessionsDir = join(workspaceRoot, ".auto-talon", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const jsonPath = join(sessionsDir, "legacy-session.json");
    await writeFile(
      jsonPath,
      JSON.stringify({
        id: "legacy-session",
        interactionMode: "plan",
        messages: [
          {
            id: "user-legacy",
            kind: "user",
            text: "migrated prompt",
            timestamp: "2026-01-01T00:00:00.000Z"
          }
        ],
        sessionApprovalFingerprints: ["fp-legacy"],
        title: "Legacy chat",
        updatedAt: "2026-01-01T01:00:00.000Z"
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });
    try {
      const sessionUiStateService = new SessionUiStateService({
        messageRepository: handle.infrastructure.storage.sessionMessages,
        sessionRepository: handle.infrastructure.storage.sessions
      });
      const result = await migrateLegacyTranscriptFiles({
        sessionRepository: handle.infrastructure.storage.sessions,
        sessionUiStateService,
        workspaceRoot
      });

      expect(result).toEqual({ migratedFiles: 1, skippedFiles: 0 });
      await expect(access(jsonPath)).rejects.toThrow();
      const migratedRaw = await readFile(`${jsonPath}.migrated`, "utf8");
      expect(migratedRaw).toContain("legacy-session");

      const uiState = handle.service.loadSessionUiState("legacy-session");
      expect(uiState?.interactionMode).toBe("plan");
      expect(uiState?.messages).toHaveLength(1);
      expect(uiState?.sessionApprovalFingerprints).toEqual(["fp-legacy"]);

      const secondPass = await migrateLegacyTranscriptFiles({
        sessionRepository: handle.infrastructure.storage.sessions,
        sessionUiStateService,
        workspaceRoot
      });
      expect(secondPass).toEqual({ migratedFiles: 0, skippedFiles: 0 });
    } finally {
      handle.close();
    }
  });
});
