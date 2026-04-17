import type { GatewayRuntimeApi, InboundMessageAdapter } from "../types";

export class GatewayManager {
  public constructor(
    private readonly runtimeApi: GatewayRuntimeApi,
    private readonly adapters: InboundMessageAdapter[]
  ) {}

  public async startAll(): Promise<void> {
    for (const adapter of this.adapters) {
      if (!adapter.descriptor.capabilities.textInteraction.supported) {
        throw new Error(
          `Adapter ${adapter.descriptor.adapterId} cannot start without textInteraction support.`
        );
      }

      adapter.descriptor.lifecycleState = "starting";
      await adapter.start({
        runtimeApi: this.runtimeApi
      });
      adapter.descriptor.lifecycleState = "running";
    }
  }

  public async stopAll(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.stop();
      adapter.descriptor.lifecycleState = "stopped";
    }
  }

  public listAdapters(): InboundMessageAdapter[] {
    return [...this.adapters];
  }
}
