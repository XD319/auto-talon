import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { EchoGatewayAdapter, GatewayManager, createGatewayRuntime } from "../src/gateway/index.js";
import { createApplication } from "../src/runtime/index.js";
import type { Provider, ProviderInput, ProviderResponse } from "../src/types/index.js";

class ScriptedProvider implements Provider {
  public readonly name = "echo-test-provider";

  public generate(input: ProviderInput): Promise<ProviderResponse> {
    return Promise.resolve({
      kind: "final",
      message: `echo:${input.task.input}`,
      usage: {
        inputTokens: 1,
        outputTokens: 1
      }
    });
  }
}

const tempPaths: string[] = [];

afterEach(async () => {
  while (tempPaths.length > 0) {
    const workspaceRoot = tempPaths.pop();
    if (workspaceRoot !== undefined) {
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  }
});

describe("Echo gateway adapter example", () => {
  it("submits tasks through GatewayRuntimeFacade with session and identity bindings", async () => {
    const workspaceRoot = createTempWorkspace();
    const handle = createApplication(workspaceRoot, {
      config: {
        databasePath: join(workspaceRoot, "runtime.db")
      },
      provider: new ScriptedProvider()
    });
    const gateway = createGatewayRuntime(handle);
    const adapter = new EchoGatewayAdapter();
    const manager = new GatewayManager(gateway, [adapter]);

    await manager.startAll();
    const launch = await adapter.submitEchoTask("hello");
    const snapshot = gateway.getTaskSnapshot(launch.result.taskId);
    await manager.stopAll();
    handle.close();

    expect(launch.notices).toHaveLength(0);
    expect(launch.result.output).toBe("echo:hello");
    expect(launch.sessionBinding.adapterId).toBe(adapter.descriptor.adapterId);
    expect(launch.sessionBinding.runtimeUserId).toBe(`${adapter.descriptor.adapterId}:echo-user`);

    expect(snapshot?.adapterSource?.adapterId).toBe(adapter.descriptor.adapterId);
    expect(snapshot?.adapterSource?.externalSessionId).toBe("echo-session");
  });
});

function createTempWorkspace(): string {
  const workspaceRoot = join(tmpdir(), `auto-talon-echo-adapter-${Date.now()}-${Math.random()}`);
  tempPaths.push(workspaceRoot);
  return workspaceRoot;
}
