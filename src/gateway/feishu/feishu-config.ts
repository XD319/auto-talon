import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const feishuConfigSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  domain: z.enum(["feishu", "lark"]).optional()
});

const feishuConfigFileSchema = z.object({
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  domain: z.enum(["feishu", "lark"]).optional(),
  version: z.number().optional()
});

export interface FeishuGatewayConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

export function resolveFeishuGatewayConfig(cwd: string): FeishuGatewayConfig {
  const configPath = join(cwd, ".auto-talon", "feishu.config.json");
  const fileConfig = existsSync(configPath)
    ? feishuConfigFileSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    : {};

  const config = feishuConfigSchema.parse({
    appId: normalizeOptionalSecret(process.env.AGENT_FEISHU_APP_ID) ?? normalizeOptionalSecret(fileConfig.appId),
    appSecret:
      normalizeOptionalSecret(process.env.AGENT_FEISHU_APP_SECRET) ??
      normalizeOptionalSecret(fileConfig.appSecret),
    domain:
      process.env.AGENT_FEISHU_DOMAIN === "lark" || process.env.AGENT_FEISHU_DOMAIN === "feishu"
        ? process.env.AGENT_FEISHU_DOMAIN
        : fileConfig.domain
  });

  return {
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.domain ?? "feishu"
  };
}

export function hasFeishuGatewayConfig(cwd: string): boolean {
  const configPath = join(cwd, ".auto-talon", "feishu.config.json");
  const fileConfig = existsSync(configPath)
    ? feishuConfigFileSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    : {};

  return (
    normalizeOptionalSecret(process.env.AGENT_FEISHU_APP_ID) !== undefined ||
    normalizeOptionalSecret(process.env.AGENT_FEISHU_APP_SECRET) !== undefined ||
    normalizeOptionalSecret(fileConfig.appId) !== undefined ||
    normalizeOptionalSecret(fileConfig.appSecret) !== undefined
  );
}

function normalizeOptionalSecret(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? undefined : normalized;
}
