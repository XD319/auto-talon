import type { AppRuntimeHandle } from "../runtime";
import type { InboundMessageAdapter } from "../types";

import { FeishuAdapter } from "./feishu/feishu-adapter";
import { resolveFeishuGatewayConfig } from "./feishu/feishu-config";
import { LocalWebhookAdapter } from "./local-webhook-adapter";

export interface GatewayAdapterPlugin {
  createAdapter(runtimeHandle: AppRuntimeHandle): InboundMessageAdapter;
  pluginId: string;
}

export function createLocalWebhookPlugin(options: {
  adapterId?: string;
  host?: string;
  port: number;
}): GatewayAdapterPlugin {
  return {
    createAdapter: () => new LocalWebhookAdapter(options),
    pluginId: "builtin:local-webhook"
  };
}

export function createFeishuGatewayPlugin(): GatewayAdapterPlugin {
  return {
    createAdapter: (runtimeHandle) =>
      new FeishuAdapter(resolveFeishuGatewayConfig(runtimeHandle.config.workspaceRoot)),
    pluginId: "gateway:feishu"
  };
}

