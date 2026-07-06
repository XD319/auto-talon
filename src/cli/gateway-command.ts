import type { Command } from "commander";

import { assertSafeHttpBind } from "../core/http-auth.js";
import {
  createGatewayApplication,
  createGatewayRuntime,
  createFeishuGatewayPlugin,
  hasFeishuGatewayConfig,
  startFeishuGateway,
  startLocalWebhookGateway,
  GatewayManager,
  LocalWebhookAdapter
} from "../gateway/index.js";
import { createApplication } from "../runtime/index.js";
import type { InboundMessageAdapter } from "../types/index.js";
import {
  collectOption,
  parsePortOption,
  resolveSandboxCliOptions,
  type SandboxCommandOptions
} from "./cli-helpers.js";

export function registerGatewayCommands(program: Command): void {
  const gatewayCommand = program
    .command("gateway")
    .description("Run minimal external gateway adapters");

  gatewayCommand
    .command("serve-webhook")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to bind", parsePortOption("--port"), 7070)
    .option("--insecure", "Allow binding to non-loopback hosts without HTTP token")
    .action(async (commandOptions: SandboxCommandOptions & { host: string; insecure?: boolean; port: number }) => {
      assertSafeHttpBind({
        cwd: commandOptions.cwd,
        host: commandOptions.host,
        insecure: commandOptions.insecure === true
      });
      const gatewayApp = createGatewayApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      const handle = gatewayApp.runtime;
      const gatewayRuntime = gatewayApp.gateway;
      const gatewayHandle = await startLocalWebhookGateway(handle, {
        host: commandOptions.host,
        port: commandOptions.port
      }, gatewayRuntime);

      console.log(
        `Local webhook adapter ${gatewayHandle.adapter.descriptor.adapterId} listening on http://${commandOptions.host}:${commandOptions.port}`
      );
      console.log("POST /tasks to submit work, GET /tasks/:taskId to inspect, GET /tasks/:taskId/events for SSE.");

      const shutdown = async (): Promise<void> => {
        await gatewayHandle.manager.stopAll();
        gatewayApp.close();
        process.exit(0);
      };

      process.once("SIGINT", () => {
        void shutdown();
      });
      process.once("SIGTERM", () => {
        void shutdown();
      });
    });

  gatewayCommand
    .command("serve-feishu")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .option("--local-webhook-port <port>", "Also start local webhook on this port", parsePortOption("--local-webhook-port"))
    .action(async (commandOptions: SandboxCommandOptions & { localWebhookPort?: number }) => {
      const gatewayApp = createGatewayApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      const handle = gatewayApp.runtime;
      const gatewayRuntime = gatewayApp.gateway;
      let extraManagers: GatewayManager[] = [];
      try {
        const feishu = await startFeishuGateway(handle, gatewayRuntime);
        extraManagers = [feishu.manager];
        if (commandOptions.localWebhookPort !== undefined) {
          const local = await startLocalWebhookGateway(handle, {
            host: "127.0.0.1",
            port: commandOptions.localWebhookPort
          }, gatewayRuntime);
          extraManagers.push(local.manager);
        }

        console.log(`Feishu adapter ${feishu.adapter.descriptor.adapterId} is running.`);
      } catch (error) {
        for (const manager of extraManagers) {
          await manager.stopAll();
        }
        gatewayApp.close();
        throw error;
      }
      const shutdown = async (): Promise<void> => {
        for (const manager of extraManagers) {
          await manager.stopAll();
        }
        gatewayApp.close();
        process.exit(0);
      };
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
    });

  gatewayCommand
    .command("list-adapters")
    .option("--cwd <path>", "Workspace path", process.cwd())
    .option("--write-root <path>", "Additional writable root (repeatable)", collectOption, [])
    .option("--sandbox-profile <name>", "Sandbox profile from .auto-talon/sandbox.config.json")
    .option("--sandbox-mode <mode>", "Sandbox mode: local | docker")
    .action((commandOptions: SandboxCommandOptions) => {
      const handle = createApplication(commandOptions.cwd, {
        sandbox: resolveSandboxCliOptions(commandOptions)
      });
      try {
        const listedAdapters: InboundMessageAdapter[] = [
          new LocalWebhookAdapter({ port: 0, adapterId: "local-webhook" })
        ];
        try {
          if (hasFeishuGatewayConfig(handle.config.workspaceRoot)) {
            listedAdapters.push(createFeishuGatewayPlugin().createAdapter(handle));
          }
        } catch {
          // Optional adapter: only listed when config is present.
        }
        const manager = new GatewayManager(createGatewayRuntime(handle), listedAdapters);
        for (const adapter of manager.listAdapters()) {
          console.log(
            `${adapter.descriptor.adapterId} (${adapter.descriptor.kind}) ${JSON.stringify(adapter.descriptor.capabilities)}`
          );
        }
      } finally {
        handle.close();
      }
    });
}
