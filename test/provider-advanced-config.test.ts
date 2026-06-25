import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addFallbackProviderConfig,
  addProviderCredentialEnvConfig,
  clearFallbackProviderConfig,
  listProviderCredentialConfig,
  removeProviderCredentialConfig,
  removeFallbackProviderConfig,
  resolveMergedFallbackConfig,
  resolveMergedFallbackProvidersForSlot,
  resolveProviderCatalog,
  resolveProviderConfig,
  resolveProviderConfigForProvider,
  resolveProviderCredentialConfigs,
  setProviderCredentialEnabledConfig
} from "../src/providers/config.js";
import { isProviderSwitchable } from "../src/providers/provider-switchable.js";

describe("advanced provider configuration", () => {
  let workspaceRoot = "";
  let userConfigDir = "";
  let previousUserConfigDir: string | undefined;
  let previousAgentProvider: string | undefined;
  let previousAgentProviderApiKey: string | undefined;
  let previousAgentProviderModel: string | undefined;
  let previousAgentProviderBaseUrl: string | undefined;
  let previousVendorKeyA: string | undefined;
  let previousVendorKeyB: string | undefined;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), "auto-talon-advanced-provider-"));
    userConfigDir = await mkdtemp(join(tmpdir(), "auto-talon-advanced-provider-user-"));
    previousUserConfigDir = process.env.AGENT_USER_CONFIG_DIR;
    previousAgentProvider = process.env.AGENT_PROVIDER;
    previousAgentProviderApiKey = process.env.AGENT_PROVIDER_API_KEY;
    previousAgentProviderModel = process.env.AGENT_PROVIDER_MODEL;
    previousAgentProviderBaseUrl = process.env.AGENT_PROVIDER_BASE_URL;
    previousVendorKeyA = process.env.VENDOR_KEY_A;
    previousVendorKeyB = process.env.VENDOR_KEY_B;

    process.env.AGENT_USER_CONFIG_DIR = userConfigDir;
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_PROVIDER_API_KEY;
    delete process.env.AGENT_PROVIDER_MODEL;
    delete process.env.AGENT_PROVIDER_BASE_URL;
    delete process.env.VENDOR_KEY_A;
    delete process.env.VENDOR_KEY_B;

    await mkdir(join(workspaceRoot, ".auto-talon"), { recursive: true });
  });

  afterEach(async () => {
    restoreEnv("AGENT_USER_CONFIG_DIR", previousUserConfigDir);
    restoreEnv("AGENT_PROVIDER", previousAgentProvider);
    restoreEnv("AGENT_PROVIDER_API_KEY", previousAgentProviderApiKey);
    restoreEnv("AGENT_PROVIDER_MODEL", previousAgentProviderModel);
    restoreEnv("AGENT_PROVIDER_BASE_URL", previousAgentProviderBaseUrl);
    restoreEnv("VENDOR_KEY_A", previousVendorKeyA);
    restoreEnv("VENDOR_KEY_B", previousVendorKeyB);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(userConfigDir, { recursive: true, force: true });
  });

  it("keeps legacy apiKey as the default credential", async () => {
    await writeWorkspaceProviderConfig({
      currentProvider: "openai-compatible",
      providers: {
        "openai-compatible": {
          apiKey: "legacy-key",
          baseUrl: "https://compat.example.test/v1",
          model: "compat-model"
        }
      }
    });

    const config = resolveProviderConfigForProvider(workspaceRoot, "openai-compatible:compat-model");

    expect(config.apiKey).toBe("legacy-key");
    expect(config.credential).toMatchObject({
      activeCredentialId: "default",
      credentialSource: "legacy_api_key",
      credentialStatus: "available"
    });
    expect(isProviderSwitchable(config)).toBe(true);
  });

  it("resolves env credential pools and credential-specific configs", async () => {
    process.env.VENDOR_KEY_B = "env-key-b";
    await writeWorkspaceProviderConfig({
      currentProvider: "openai-compatible",
      providers: {
        "openai-compatible": {
          baseUrl: "https://compat.example.test/v1",
          credentials: [
            { apiKeyEnv: "MISSING_VENDOR_KEY", id: "missing", priority: 0 },
            { apiKeyEnv: "VENDOR_KEY_B", id: "env-b", priority: 1 },
            { apiKey: "plain-key", id: "plain", priority: 2 },
            { apiKey: "disabled-key", disabled: true, id: "disabled", priority: 3 }
          ],
          model: "compat-model"
        }
      }
    });

    const config = resolveProviderConfigForProvider(workspaceRoot, "openai-compatible:compat-model");
    const credentialConfigs = resolveProviderCredentialConfigs(workspaceRoot, "openai-compatible:compat-model");

    expect(config.apiKey).toBe("env-key-b");
    expect(config.credential).toMatchObject({
      activeCredentialId: "env-b",
      availableCredentialIds: ["env-b", "plain"],
      credentialCount: 4,
      credentialSource: "env",
      credentialStatus: "available"
    });
    expect(credentialConfigs.map((entry) => entry.credential.activeCredentialId)).toEqual([
      "env-b",
      "plain"
    ]);
    expect(credentialConfigs.map((entry) => entry.apiKey)).toEqual(["env-key-b", "plain-key"]);
  });

  it("writes provider credential pool entries while preserving compatibility", () => {
    const added = addProviderCredentialEnvConfig("openai-compatible", {
      cwd: workspaceRoot,
      envName: "VENDOR_KEY_A",
      id: "vendor-a",
      priority: 5,
      scope: "workspace"
    });

    expect(added.credentials).toEqual([
      {
        apiKeyEnv: "VENDOR_KEY_A",
        cooldownUntil: null,
        disabled: false,
        id: "vendor-a",
        lastFailure: null,
        priority: 5
      }
    ]);

    expect(
      setProviderCredentialEnabledConfig("openai-compatible", "vendor-a", false, {
        cwd: workspaceRoot,
        scope: "workspace"
      }).credentials[0]?.disabled
    ).toBe(true);
    expect(
      setProviderCredentialEnabledConfig("openai-compatible", "vendor-a", true, {
        cwd: workspaceRoot,
        scope: "workspace"
      }).credentials[0]?.disabled
    ).toBe(false);
    expect(
      listProviderCredentialConfig("openai-compatible", {
        cwd: workspaceRoot,
        scope: "workspace"
      }).credentials
    ).toHaveLength(1);
    expect(
      removeProviderCredentialConfig("openai-compatible", "vendor-a", {
        cwd: workspaceRoot,
        scope: "workspace"
      }).credentials
    ).toEqual([]);
  });

  it("merges main and auxiliary fallback chains with legacy fallbackProviders", async () => {
    await writeUserProviderConfig({
      fallback: {
        auxiliary: {
          reviewer: ["user-reviewer:user-model"],
          summarize: ["user-summary:user-model"]
        },
        main: ["user-main-new:user-model"]
      },
      fallbackProviders: ["user-main:user-model"]
    });
    await writeWorkspaceProviderConfig({
      fallback: {
        auxiliary: {
          reviewer: ["workspace-reviewer:workspace-model"]
        },
        main: ["workspace-main-new:workspace-model"]
      },
      fallbackProviders: ["workspace-main:workspace-model"]
    });

    const fallback = resolveMergedFallbackConfig(workspaceRoot);

    expect(fallback.main).toEqual([
      "workspace-main-new:workspace-model",
      "workspace-main:workspace-model",
      "user-main-new:user-model",
      "user-main:user-model"
    ]);
    expect(fallback.auxiliary).toEqual({
      reviewer: ["workspace-reviewer:workspace-model", "user-reviewer:user-model"],
      summarize: ["user-summary:user-model"]
    });
    expect(resolveMergedFallbackProvidersForSlot(workspaceRoot, "reviewer")).toEqual([
      "workspace-reviewer:workspace-model",
      "user-reviewer:user-model"
    ]);
    expect(resolveMergedFallbackProvidersForSlot(workspaceRoot, "missing-slot")).toEqual(
      fallback.main
    );
  });

  it("writes auxiliary fallback without dropping the legacy main chain", async () => {
    await writeWorkspaceProviderConfig({
      customProviders: {
        backup: {
          apiKey: "backup-key",
          baseUrl: "https://backup.example.test/v1",
          displayName: "Backup",
          model: "backup-model",
          transport: "openai-compatible"
        }
      },
      fallbackProviders: ["backup:main-model"]
    });

    addFallbackProviderConfig("backup:backup-model", {
      cwd: workspaceRoot,
      scope: "workspace",
      slot: "reviewer"
    });
    let parsed = await readWorkspaceProviderConfig();
    expect(parsed.fallbackProviders).toEqual(["backup:main-model"]);
    expect(parsed.fallback).toMatchObject({
      auxiliary: { reviewer: ["backup:backup-model"] }
    });

    removeFallbackProviderConfig("backup:backup-model", {
      cwd: workspaceRoot,
      scope: "workspace",
      slot: "reviewer"
    });
    parsed = await readWorkspaceProviderConfig();
    expect(parsed.fallbackProviders).toEqual(["backup:main-model"]);
    expect(parsed.fallback?.auxiliary?.reviewer).toBeUndefined();

    clearFallbackProviderConfig({ cwd: workspaceRoot, scope: "workspace" });
    parsed = await readWorkspaceProviderConfig();
    expect(parsed.fallbackProviders).toBeUndefined();
  });

  it("loads workspace provider manifests into catalog and resolution", async () => {
    await mkdir(join(workspaceRoot, ".auto-talon", "providers"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".auto-talon", "providers", "vendor-manifest.json"),
      JSON.stringify({
        contextWindowTokens: 12345,
        displayName: "Vendor Manifest",
        name: "vendor-manifest",
        openAiCompatible: {
          defaultBaseUrl: "https://manifest.example.test/v1",
          defaultDisplayName: "Vendor Manifest",
          defaultModel: "manifest-model",
          providerLabel: "Vendor Manifest"
        },
        supportsStreaming: false,
        supportsToolCalls: false,
        transport: "openai-compatible"
      }),
      "utf8"
    );
    await writeWorkspaceProviderConfig({
      currentProvider: "vendor-manifest",
      providers: {
        "vendor-manifest": {
          apiKey: "manifest-key"
        }
      }
    });

    const config = resolveProviderConfig(workspaceRoot);
    const catalogEntry = resolveProviderCatalog(workspaceRoot).find(
      (entry) => entry.name === "vendor-manifest"
    );

    expect(config).toMatchObject({
      apiKey: "manifest-key",
      baseUrl: "https://manifest.example.test/v1",
      contextWindowTokens: 12345,
      displayName: "Vendor Manifest",
      model: "manifest-model",
      name: "vendor-manifest",
      supportsStreaming: false,
      supportsToolCalls: false,
      transport: "openai-compatible"
    });
    expect(catalogEntry).toMatchObject({
      displayName: "Vendor Manifest",
      name: "vendor-manifest",
      supportsStreaming: false,
      supportsToolCalls: false
    });
  });

  async function writeWorkspaceProviderConfig(config: unknown): Promise<void> {
    await writeFile(
      join(workspaceRoot, ".auto-talon", "provider.config.json"),
      JSON.stringify(config, null, 2),
      "utf8"
    );
  }

  async function writeUserProviderConfig(config: unknown): Promise<void> {
    await writeFile(join(userConfigDir, "provider.config.json"), JSON.stringify(config, null, 2), "utf8");
  }

  async function readWorkspaceProviderConfig(): Promise<ProviderConfigSnapshot> {
    return JSON.parse(
      await readFile(join(workspaceRoot, ".auto-talon", "provider.config.json"), "utf8")
    ) as ProviderConfigSnapshot;
  }
});

interface ProviderConfigSnapshot {
  fallback?: {
    auxiliary?: Record<string, string[]>;
    main?: string[];
  };
  fallbackProviders?: string[];
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}