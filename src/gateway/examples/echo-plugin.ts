import type { AppRuntimeHandle } from "../../runtime/index.js";
import type { GatewayAdapterPlugin } from "../plugins.js";

import { EchoGatewayAdapter } from "./echo-adapter.js";

const createEchoAdapter = (runtimeHandle: AppRuntimeHandle): EchoGatewayAdapter => {
  void runtimeHandle;
  return new EchoGatewayAdapter();
};

export function createEchoGatewayPlugin(): GatewayAdapterPlugin {
  return {
    createAdapter: createEchoAdapter,
    pluginId: "example:echo"
  };
}
