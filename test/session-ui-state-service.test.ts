import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApplication } from "../src/runtime/index.js";
import { readSessionModelSelection } from "../src/runtime/operations/model-selection-service.js";

const tempPaths: string[] = [];
let previousUserConfigDir: string | undefined;

beforeEach(() => {
  previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
});

afterEach(async () => {
  if (previousUserConfigDir === undefined) {
    delete process.env.AGENT_USER_CONFIG_DIR;
  } else {
    process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
  }
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      await fs.rm(tempPath, { force: true, recursive: true });
    }
  }
});

async function createWorkspaceWithProviders(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(join(tmpdir(), "auto-talon-ui-state-"));
  const userConfigDir = await fs.mkdtemp(join(tmpdir(), "auto-talon-ui-state-user-"));
  tempPaths.push(workspaceRoot, userConfigDir);
  process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
  await fs.mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
  await fs.writeFile(
    join(workspaceRoot, ".auto-talon", "runtime.config.json"),
    JSON.stringify({ version: 1 }),
    "utf8"
  );
  await fs.writeFile(
    join(workspaceRoot, ".auto-talon", "provider.config.json"),
    JSON.stringify({
      currentProvider: "vendor-a",
      customProviders: {
        "vendor-a": {
          transport: "openai-compatible",
          displayName: "Vendor A",
          baseUrl: "https://vendor-a.example.test/v1",
          apiKey: "vendor-a-key",
          model: "vendor-a-model"
        },
        "vendor-b": {
          transport: "openai-compatible",
          displayName: "Vendor B",
          baseUrl: "https://vendor-b.example.test/v1",
          apiKey: "vendor-b-key",
          model: "vendor-b-model"
        }
      }
    }),
    "utf8"
  );
  return workspaceRoot;
}

describe("SessionUiStateService save", () => {
  it("preserves session modelSelection when providerSelection is omitted", async () => {
    const workspaceRoot = await createWorkspaceWithProviders();
    const handle = createApplication(workspaceRoot, {
      config: { databasePath: join(workspaceRoot, "runtime.db") }
    });
    try {
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        ownerUserId: "local-user",
        providerName: "vendor-a",
        title: "Model session"
      });
      await handle.service.setSessionModelSelection({
        selection: "vendor-b:vendor-b-model",
        sessionId: session.sessionId
      });

      handle.service.saveSessionUiState(session.sessionId, {
        entrySource: "tui",
        interactionMode: "agent",
        messages: [{ id: "user:1", kind: "user", text: "hello", timestamp: "2026-01-01T00:00:00.000Z" }],
        title: "Model session"
      });

      const uiState = handle.service.loadSessionUiState(session.sessionId);
      expect(uiState?.providerSelection).toBe("vendor-b:vendor-b-model");
      const persisted = handle.service.findSession(session.sessionId);
      expect(readSessionModelSelection(persisted?.metadata ?? {})?.selection).toBe("vendor-b:vendor-b-model");
    } finally {
      handle.close();
    }
  });
});
