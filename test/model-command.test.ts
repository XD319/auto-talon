import { describe, expect, it } from "vitest";

import {
  formatModelListMessage,
  parseModelCommand
} from "../src/tui/model-command.js";
import type { ModelSelectionView } from "../src/runtime/operations/model-selection-service.js";
import type { ResolvedProviderConfig } from "../src/providers/config.js";

describe("parseModelCommand", () => {
  it("parses list, status, default, and numbered commands", () => {
    expect(parseModelCommand("/model")).toEqual({
      action: "list",
      persist: "session"
    });
    expect(parseModelCommand("/model list")).toEqual({
      action: "list",
      persist: "session"
    });
    expect(parseModelCommand("/model status")).toEqual({
      action: "status",
      persist: "session"
    });
    expect(parseModelCommand("/model default")).toEqual({
      action: "clear",
      persist: "session"
    });
    expect(parseModelCommand("/model 2")).toEqual({
      action: "switch",
      index: 2,
      persist: "session",
      selection: null
    });
  });

  it("parses selection with persist flags", () => {
    expect(parseModelCommand("/model deepseek:deepseek-chat --global")).toEqual({
      action: "switch",
      index: null,
      persist: "user",
      selection: "deepseek:deepseek-chat"
    });
    expect(parseModelCommand("/model openai/gpt-4o-mini --workspace")).toEqual({
      action: "switch",
      index: null,
      persist: "workspace",
      selection: "openai/gpt-4o-mini"
    });
    expect(parseModelCommand("/model --global")).toEqual({
      action: "list",
      persist: "user"
    });
  });

  it("rejects unknown flags", () => {
    expect(() => parseModelCommand("/model mock:mock --unknown")).toThrow(/Unknown \/model flag/);
  });
});

describe("formatFlagsOnlyModelHint", () => {
  it("explains persist flags require a selection", async () => {
    const { formatFlagsOnlyModelHint } = await import("../src/tui/model-command.js");
    expect(formatFlagsOnlyModelHint("user")).toContain("requires a model selection");
  });
});

describe("formatModelListMessage", () => {
  it("includes current model and configured providers", () => {
    const message = formatModelListMessage(createModelView());

    expect(message).toContain("Current model: deepseek:deepseek-chat");
    expect(message).toContain("Source: workspace config");
    expect(message).toContain("1. deepseek:deepseek-chat (DeepSeek)");
    expect(message).toContain("Aliases:");
    expect(message).toContain("fav -> deepseek:deepseek-chat");
    expect(message).toContain("Fallback: backup:backup-model");
    expect(message).toContain("Auxiliary: reviewer=deepseek:deepseek-chat");
  });
});

describe("handleModelCommand", () => {
  it("blocks switches while busy", async () => {
    const { handleModelCommand } = await import("../src/tui/model-command-handler.js");
    const result = await handleModelCommand({
      activeSessionId: "session-1",
      busy: true,
      cwd: process.cwd(),
      currentProvider,
      pendingApproval: false,
      pendingClarify: false,
      service: createModelCommandService(),
      text: "/model mock:mock"
    });
    expect(result?.kind).toBe("error");
    expect(result?.message).toContain("task is running");
  });

  it("blocks switches while approval is pending", async () => {
    const { handleModelCommand } = await import("../src/tui/model-command-handler.js");
    const result = await handleModelCommand({
      activeSessionId: "session-1",
      busy: false,
      cwd: process.cwd(),
      currentProvider,
      pendingApproval: true,
      pendingClarify: false,
      service: createModelCommandService(),
      text: "/model mock:mock"
    });
    expect(result?.kind).toBe("error");
    expect(result?.message).toContain("approval is pending");
  });

  it("switches by configured model number", async () => {
    const { handleModelCommand } = await import("../src/tui/model-command-handler.js");
    let selected = "";
    const result = await handleModelCommand({
      activeSessionId: "session-1",
      busy: false,
      cwd: process.cwd(),
      currentProvider,
      pendingApproval: false,
      pendingClarify: false,
      service: createModelCommandService({
        switchProvider: (input) => {
          selected = input.selection;
          return Promise.resolve({
            provider: {} as never,
            providerConfig: currentProvider,
            selection: input.selection,
            tokenBudget: {
              inputLimit: 64_000,
              outputLimit: 4_096,
              reservedOutput: 4_096
            }
          });
        }
      }),
      text: "/model 1"
    });
    expect(result?.kind).toBe("switched");
    expect(selected).toBe("deepseek:deepseek-chat");
  });

  it("clears the active session override", async () => {
    const { handleModelCommand } = await import("../src/tui/model-command-handler.js");
    const result = await handleModelCommand({
      activeSessionId: "session-1",
      busy: false,
      cwd: process.cwd(),
      currentProvider,
      pendingApproval: false,
      pendingClarify: false,
      service: createModelCommandService(),
      text: "/model default"
    });
    expect(result?.kind).toBe("cleared");
    expect(result?.message).toContain("Session model override cleared");
  });
});

const currentProvider: ResolvedProviderConfig = {
  apiKey: "sk-test",
  baseUrl: "https://api.deepseek.com/v1",
  builtinProviderName: null,
  configPath: "/tmp/provider.config.json",
  configSource: "file",
  configured: true,
  contextWindowSource: null,
  contextWindowTokens: 64_000,
  displayName: "DeepSeek",
  family: "openai-compatible",
  maxRetries: 2,
  model: "deepseek-chat",
  name: "deepseek",
  streamIdleTimeoutConfigured: false,
  streamIdleTimeoutMs: 300_000,
  timeoutConfigured: false,
  timeoutMs: 120_000,
  transport: "openai-compatible"
};

function createModelView(): ModelSelectionView {
  return {
    aliases: [{ alias: "fav", current: true, target: "deepseek:deepseek-chat" }],
    auxiliary: { reviewer: "deepseek:deepseek-chat" },
    configuredModels: [
      {
        baseUrl: currentProvider.baseUrl,
        configSource: "file",
        contextWindowTokens: currentProvider.contextWindowTokens,
        current: true,
        displayName: currentProvider.displayName,
        model: currentProvider.model,
        providerName: currentProvider.name,
        selection: "deepseek:deepseek-chat",
        source: "workspace",
        strict: false,
        transport: currentProvider.transport
      }
    ],
    current: {
      baseUrl: currentProvider.baseUrl,
      configSource: "file",
      contextWindowTokens: currentProvider.contextWindowTokens,
      current: true,
      displayName: currentProvider.displayName,
      model: currentProvider.model,
      providerName: currentProvider.name,
      selection: "deepseek:deepseek-chat",
      source: "workspace",
      strict: false,
      transport: currentProvider.transport
    },
    envOnlyProviders: [],
    fallbackProviders: ["backup:backup-model"],
    routing: {
      helpers: { classify: null, recallRank: null, summarize: null },
      mode: "balanced",
      providers: { balanced: null, cheap: null, quality: null }
    },
    session: {
      modelSelection: null,
      sessionId: "session-1"
    }
  };
}

function createModelCommandService(overrides: Partial<{
  clearSessionModelSelection: (sessionId: string) => Promise<{
    result: {
      providerConfig: ResolvedProviderConfig;
      tokenBudget: { inputLimit: number; outputLimit: number; reservedOutput: number };
    } | null;
    session: { sessionId: string };
    view: ModelSelectionView;
  }>;
  modelSelectionView: () => ModelSelectionView;
  switchProvider: (input: { persist: string; selection: string; sessionId?: string }) => Promise<{
    provider: never;
    providerConfig: ResolvedProviderConfig;
    selection: string;
    tokenBudget: { inputLimit: number; outputLimit: number; reservedOutput: number };
  }>;
}> = {}) {
  return {
    clearSessionModelSelection:
      overrides.clearSessionModelSelection ??
      ((sessionId: string) => Promise.resolve({
        result: null,
        session: { sessionId },
        view: createModelView()
      })),
    modelSelectionView: overrides.modelSelectionView ?? (() => createModelView()),
    switchProvider:
      overrides.switchProvider ??
      ((input: { persist: string; selection: string; sessionId?: string }) => Promise.resolve({
        provider: {} as never,
        providerConfig: currentProvider,
        selection: input.selection,
        tokenBudget: {
          inputLimit: 64_000,
          outputLimit: 4_096,
          reservedOutput: 4_096
        }
      }))
  };
}


