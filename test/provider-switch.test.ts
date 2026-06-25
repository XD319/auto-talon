import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApplication } from "../src/runtime/bootstrap.js";
import { readSessionModelSelection } from "../src/runtime/operations/model-selection-service.js";
import { resolveProviderConfigForSwitch } from "../src/providers/config.js";
import {
  formatProviderSelection,
  isProviderSwitchable,
  listConfiguredProviders
} from "../src/runtime/operations/provider-switch-service.js";

describe("provider switch service", () => {
  let workspaceRoot = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-switch-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-switch-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_PROVIDER_API_KEY;
    delete process.env.AGENT_PROVIDER_MODEL;
    delete process.env.AGENT_PROVIDER_BASE_URL;

    await mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({ version: 1 }),
      "utf8"
    );
    await writeFile(
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
  });

  afterEach(async () => {
    if (previousUserConfigDir === undefined) {
      delete process.env.AGENT_USER_CONFIG_DIR;
    } else {
      process.env.AGENT_USER_CONFIG_DIR = previousUserConfigDir;
    }
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("lists only configured custom providers", () => {
    const configured = listConfiguredProviders(workspaceRoot);
    expect(configured.map((entry) => entry.name).sort()).toEqual(["vendor-a", "vendor-b"]);
  });

  it("resolves switch config without env overrides", () => {
    process.env.AGENT_PROVIDER_MODEL = "env-model";
    const resolved = resolveProviderConfigForSwitch(workspaceRoot, "vendor-b:vendor-b-model");
    expect(resolved.name).toBe("vendor-b");
    expect(resolved.model).toBe("vendor-b-model");
    expect(isProviderSwitchable(resolved)).toBe(true);
    expect(formatProviderSelection(resolved)).toBe("vendor-b:vendor-b-model");
  });

  it("switches provider at runtime through application service", async () => {
    const handle = createApplication(workspaceRoot);
    try {
      expect(handle.service.currentProvider().name).toBe("vendor-a");
      const result = await handle.service.switchProvider({
        persist: "session",
        selection: "vendor-b:vendor-b-model"
      });
      expect(result.providerConfig.name).toBe("vendor-b");
      expect(handle.service.currentProvider().model).toBe("vendor-b-model");
    } finally {
      handle.close();
    }
  });

  it("persists alias selections as the resolved provider name", async () => {
    await writeFile(
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
        },
        modelAliases: {
          backup: "vendor-b:vendor-b-model"
        }
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot);
    try {
      await handle.service.switchProvider({
        persist: "workspace",
        selection: "backup"
      });
      const saved = JSON.parse(
        await readFile(join(workspaceRoot, ".auto-talon", "provider.config.json"), "utf8")
      ) as { currentProvider: string };
      expect(saved.currentProvider).toBe("vendor-b");
    } finally {
      handle.close();
    }
  });

  it("persists and clears session model selection metadata", async () => {
    const handle = createApplication(workspaceRoot);
    try {
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        metadata: {},
        ownerUserId: "local-user",
        providerName: "vendor-a",
        title: "Session model"
      });

      const selected = await handle.service.setSessionModelSelection({
        selection: "vendor-b:vendor-b-model",
        sessionId: session.sessionId
      });
      expect(readSessionModelSelection(selected.session.metadata)?.selection).toBe("vendor-b:vendor-b-model");
      expect(selected.view.current.source).toBe("session_user");
      expect(selected.view.current.strict).toBe(true);

      const cleared = await handle.service.clearSessionModelSelection(session.sessionId);
      expect(readSessionModelSelection(cleared.session.metadata)).toBeNull();
      expect(cleared.view.current.source).not.toBe("session_user");
      expect(cleared.view.current.selection).toBe("vendor-a:vendor-a-model");
    } finally {
      handle.close();
    }
  });

  it("reports explicit runtime switch above routing.providers in the model view", async () => {
    await writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        routing: {
          helpers: { classify: null, recallRank: null, summarize: "cheap" },
          mode: "quality_first",
          providers: { balanced: "vendor-a", cheap: "vendor-a", quality: "vendor-b" }
        },
        version: 1
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot);
    try {
      await handle.service.switchProvider({
        persist: "session",
        selection: "vendor-a:vendor-a-model"
      });
      const view = handle.service.modelSelectionView();
      expect(view.current.selection).toBe("vendor-a:vendor-a-model");
      expect(view.current.source).toBe("runtime");
    } finally {
      handle.close();
    }
  });
  it("keeps explicit session model selection effective when routing.providers is configured", async () => {
    await writeFile(
      join(workspaceRoot, ".auto-talon", "runtime.config.json"),
      JSON.stringify({
        routing: {
          helpers: { classify: null, recallRank: null, summarize: "cheap" },
          mode: "quality_first",
          providers: { balanced: "vendor-a", cheap: "vendor-a", quality: "vendor-b" }
        },
        version: 1
      }),
      "utf8"
    );

    const handle = createApplication(workspaceRoot);
    try {
      const session = handle.service.createSession({
        agentProfileId: "executor",
        cwd: workspaceRoot,
        metadata: {},
        ownerUserId: "local-user",
        providerName: "vendor-a",
        title: "Routing model"
      });
      await handle.service.setSessionModelSelection({
        selection: "vendor-a:vendor-a-model",
        sessionId: session.sessionId
      });
      const view = handle.service.modelSelectionView(session.sessionId);
      expect(view.current.selection).toBe("vendor-a:vendor-a-model");
      expect(view.current.source).toBe("session_user");
      expect(handle.service.currentProvider().name).toBe("vendor-a");
    } finally {
      handle.close();
    }
  });
});


