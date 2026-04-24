import type {
  AdapterDescriptor,
  GatewayRuntimeApi,
  GatewayTaskLaunchResult,
  GatewayTaskRequest,
  InboundMessageAdapter
} from "../../types/index.js";

export class EchoGatewayAdapter implements InboundMessageAdapter {
  public readonly descriptor: AdapterDescriptor = {
    adapterId: "example-echo",
    contractVersion: 1,
    capabilities: {
      approvalInteraction: { supported: false },
      attachmentCapability: { supported: false },
      fileCapability: { supported: false },
      streamingCapability: { supported: false },
      structuredCardCapability: { supported: false },
      textInteraction: { supported: true }
    },
    description: "Minimal in-memory gateway adapter example for extension tests.",
    displayName: "Echo Gateway Adapter",
    kind: "sdk",
    lifecycleState: "created"
  };

  private runtimeApi: GatewayRuntimeApi | null = null;

  public start(context: { runtimeApi: GatewayRuntimeApi }): Promise<void> {
    this.runtimeApi = context.runtimeApi;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.runtimeApi = null;
    return Promise.resolve();
  }

  public async submitEchoTask(taskInput: string): Promise<GatewayTaskLaunchResult> {
    if (this.runtimeApi === null) {
      throw new Error("EchoGatewayAdapter is not started.");
    }
    const request: GatewayTaskRequest = {
      continuation: "new",
      requester: {
        externalSessionId: "echo-session",
        externalUserId: "echo-user",
        externalUserLabel: "Echo User"
      },
      taskInput
    };
    return this.runtimeApi.submitTask(this.descriptor, request);
  }
}
