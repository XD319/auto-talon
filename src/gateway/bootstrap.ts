import type { AppRuntimeHandle, CreateApplicationOptions } from "../runtime";
import { createApplication } from "../runtime";

import { GatewayManager } from "./gateway-manager";
import { GatewayGuard } from "./gateway-guard";
import { DefaultGatewayIdentityMapper } from "./identity-mapper";
import { LocalWebhookAdapter } from "./local-webhook-adapter";
import { createFeishuGatewayPlugin, createLocalWebhookPlugin, type GatewayAdapterPlugin } from "./plugins";
import { GatewayRuntimeFacade } from "./runtime-facade";
import { RepositoryBackedGatewaySessionMapper } from "./session-mapper";

export function createGatewayRuntime(runtimeHandle: AppRuntimeHandle): GatewayRuntimeFacade {
  return new GatewayRuntimeFacade({
    applicationService: runtimeHandle.service,
    auditService: runtimeHandle.infrastructure.auditService,
    createRunOptions: runtimeHandle.infrastructure.createRunOptions,
    defaultCwd: runtimeHandle.config.workspaceRoot,
    guard: new GatewayGuard({
      cwd: runtimeHandle.config.workspaceRoot
    }),
    identityMapper: new DefaultGatewayIdentityMapper(),
    sessionMapper: new RepositoryBackedGatewaySessionMapper(
      runtimeHandle.infrastructure.storage.gatewaySessions
    ),
    traceService: runtimeHandle.infrastructure.traceService
  });
}

export interface GatewayApplicationHandle {
  close: () => void;
  gateway: GatewayRuntimeFacade;
  runtime: AppRuntimeHandle;
}

export function createGatewayApplication(
  cwd = process.cwd(),
  options: CreateApplicationOptions = {}
): GatewayApplicationHandle {
  const runtime = createApplication(cwd, options);
  return {
    close: () => runtime.close(),
    gateway: createGatewayRuntime(runtime),
    runtime
  };
}

export interface LocalWebhookGatewayHandle {
  adapter: LocalWebhookAdapter;
  manager: GatewayManager;
}

export async function startGatewayPlugin(
  runtimeHandle: AppRuntimeHandle,
  plugin: GatewayAdapterPlugin
): Promise<{ adapter: ReturnType<GatewayAdapterPlugin["createAdapter"]>; manager: GatewayManager }> {
  const adapter = plugin.createAdapter(runtimeHandle);
  const manager = new GatewayManager(createGatewayRuntime(runtimeHandle), [adapter]);
  await manager.startAll();
  return { adapter, manager };
}

export async function startLocalWebhookGateway(
  runtimeHandle: AppRuntimeHandle,
  options: { host?: string; port: number }
): Promise<LocalWebhookGatewayHandle> {
  const adapterOptions =
    options.host === undefined
      ? { port: options.port }
      : { host: options.host, port: options.port };
  const started = await startGatewayPlugin(runtimeHandle, createLocalWebhookPlugin(adapterOptions));
  const adapter = started.adapter as LocalWebhookAdapter;

  return {
    adapter,
    manager: started.manager
  };
}

export interface FeishuGatewayHandle {
  adapter: ReturnType<GatewayAdapterPlugin["createAdapter"]>;
  manager: GatewayManager;
}

export async function startFeishuGateway(runtimeHandle: AppRuntimeHandle): Promise<FeishuGatewayHandle> {
  return startGatewayPlugin(runtimeHandle, createFeishuGatewayPlugin());
}
