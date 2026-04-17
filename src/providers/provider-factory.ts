import type { Provider } from "../types";

import { MockProvider } from "./mock-provider";
import type { ResolvedProviderConfig } from "./config";
import { GlmProvider } from "./glm-provider";

export function createProvider(config: ResolvedProviderConfig): Provider {
  if (config.name === "glm") {
    return new GlmProvider(config);
  }

  return new MockProvider(config);
}
