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
  });
});

describe("formatModelListMessage", () => {
  it("includes current model and configured providers", () => {
    const message = formatModelListMessage({
      aliases: { fav: "deepseek:deepseek-chat" },
      configuredProviders: [
        {
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
    expect(message).toContain("deepseek (DeepSeek)");
    expect(message).toContain("Aliases:");
    expect(message).toContain("fav -> deepseek:deepseek-chat");
  });
});
