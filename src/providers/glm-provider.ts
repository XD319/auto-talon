import type { ProviderConfig } from "../types";

import { OpenAiCompatibleProvider } from "./openai-compatible-provider";
import { requireProviderManifest } from "./provider-registry";

export class GlmProvider extends OpenAiCompatibleProvider {
  public constructor(config: ProviderConfig) {
    super(config, requireProviderManifest("glm").openAiCompatible ?? {
      defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultDisplayName: "GLM",
      defaultModel: "glm-4.5-air",
      providerLabel: "GLM"
    });
  }
}
