import { describe, expect, it } from "vitest";

import {
  formatModelListMessage,
  parseModelCommand
} from "../src/tui/model-command.js";

describe("parseModelCommand", () => {
  it("parses list and bare commands", () => {
    expect(parseModelCommand("/model")).toEqual({
      persist: "session",
      selection: null
    });
    expect(parseModelCommand("/model list")).toEqual({
      persist: "session",
      selection: null
    });
  });

  it("parses selection with persist flags", () => {
    expect(parseModelCommand("/model deepseek:deepseek-chat --global")).toEqual({
      persist: "user",
      selection: "deepseek:deepseek-chat"
    });
    expect(parseModelCommand("/model openai/gpt-4o-mini --workspace")).toEqual({
      persist: "workspace",
      selection: "openai/gpt-4o-mini"
    });
    expect(parseModelCommand("/model --global")).toEqual({
      persist: "user",
      selection: null
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
    const message = formatModelListMessage({
      aliases: { fav: "deepseek:deepseek-chat" },
      configuredProviders: [
        {
          configSource: "user",
          displayName: "DeepSeek",
          model: "deepseek-chat",
          name: "deepseek",
          providerConfig: {
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
          }
        }
      ],
      current: {
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
      }
    });

    expect(message).toContain("Current model: deepseek:deepseek-chat");
    expect(message).toContain("deepseek:deepseek-chat (DeepSeek)");
    expect(message).toContain("[user]");
    expect(message).toContain("Aliases:");
    expect(message).toContain("fav -> deepseek:deepseek-chat");
  });
});

describe("handleModelCommand", () => {
  const currentProvider = {
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com/v1",
    builtinProviderName: null,
    configPath: "/tmp/provider.config.json",
    configSource: "file" as const,
    configured: true,
    contextWindowSource: null,
    contextWindowTokens: 64_000,
    displayName: "DeepSeek",
    family: "openai-compatible" as const,
    maxRetries: 2,
    model: "deepseek-chat",
    name: "deepseek",
    streamIdleTimeoutConfigured: false,
    streamIdleTimeoutMs: 300_000,
    timeoutConfigured: false,
    timeoutMs: 120_000,
    transport: "openai-compatible" as const
  };

  it("blocks switches while busy", async () => {
    const { handleModelCommand } = await import("../src/tui/model-command-handler.js");
    const result = await handleModelCommand({
      busy: true,
      cwd: process.cwd(),
      currentProvider,
      pendingApproval: false,
      pendingClarify: false,
      service: {
        listConfiguredProviders: () => [],
        switchProvider: async () => {
          throw new Error("should not switch");
        }
      },
      text: "/model mock:mock"
    });
    expect(result?.kind).toBe("error");
    expect(result?.message).toContain("task is running");
  });

  it("blocks switches while approval is pending", async () => {
    const { handleModelCommand } = await import("../src/tui/model-command-handler.js");
    const result = await handleModelCommand({
      busy: false,
      cwd: process.cwd(),
      currentProvider,
      pendingApproval: true,
      pendingClarify: false,
      service: {
        listConfiguredProviders: () => [],
        switchProvider: async () => {
          throw new Error("should not switch");
        }
      },
      text: "/model mock:mock"
    });
    expect(result?.kind).toBe("error");
    expect(result?.message).toContain("approval is pending");
  });
});
