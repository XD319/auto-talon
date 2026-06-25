import { z } from "zod";

const providerCredentialEntrySchema = z
  .object({
    apiKey: z.string().nullable().optional(),
    apiKeyEnv: z.string().nullable().optional(),
    cooldownUntil: z.string().nullable().optional(),
    disabled: z.boolean().optional(),
    id: z.string().min(1).optional(),
    lastFailure: z.string().nullable().optional(),
    priority: z.number().finite().optional()
  })
  .passthrough();

const providerFileEntrySchema = z
  .object({
    apiKey: z.string().nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
    credentials: z.array(providerCredentialEntrySchema).optional(),
    maxRetries: z.number().int().positive().optional(),
    model: z.string().nullable().optional(),
    streamIdleTimeoutMs: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional()
  })
  .passthrough();

const customProviderFileEntrySchema = providerFileEntrySchema
  .extend({
    anthropicVersion: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
    providerLabel: z.string().nullable().optional(),
    transport: z.enum(["openai-compatible", "anthropic-compatible"]).optional()
  })
  .passthrough();

export const providerConfigFileSchema = z
  .object({
    version: z.number().int().positive().optional(),
    currentProvider: z.string().min(1).optional(),
    customProviders: z.record(z.string(), customProviderFileEntrySchema).optional(),
    fallbackProviders: z.array(z.string().min(1)).optional(),
    fallback: z
      .object({
        auxiliary: z.record(z.string(), z.array(z.string().min(1))).optional(),
        main: z.array(z.string().min(1)).optional()
      })
      .passthrough()
      .optional(),
    modelAliases: z.record(z.string(), z.string()).optional(),
    providers: z.record(z.string(), providerFileEntrySchema).optional()
  })
  .passthrough();

export type ProviderConfigFileSchema = z.infer<typeof providerConfigFileSchema>;

export const externalProviderManifestSchema = z
  .object({
    aliases: z.array(z.string().min(1)).optional(),
    anthropicCompatible: z
      .object({
        anthropicVersion: z.string().optional(),
        defaultBaseUrl: z.string().nullable(),
        defaultDisplayName: z.string(),
        defaultModel: z.string(),
        providerLabel: z.string().optional()
      })
      .optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
    displayName: z.string().min(1),
    name: z.string().min(1),
    openAiCompatible: z
      .object({
        defaultBaseUrl: z.string().nullable(),
        defaultDisplayName: z.string(),
        defaultModel: z.string(),
        providerLabel: z.string().optional()
      })
      .optional(),
    supportsConfiguration: z.boolean().optional(),
    supportsStreaming: z.boolean().optional(),
    supportsToolCalls: z.boolean().optional(),
    transport: z.enum(["openai-compatible", "anthropic-compatible", "mock"])
  })
  .passthrough();

export type ExternalProviderManifestSchema = z.infer<typeof externalProviderManifestSchema>;

export function parseProviderConfigFile(content: unknown, configPath: string): ProviderConfigFileSchema {
  const parsed = providerConfigFileSchema.safeParse(content);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid provider config ${configPath}: ${details}`);
  }
  return parsed.data;
}

export function parseExternalProviderManifest(
  content: unknown,
  manifestPath: string
): ExternalProviderManifestSchema {
  const parsed = externalProviderManifestSchema.safeParse(content);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid provider manifest ${manifestPath}: ${details}`);
  }
  if (parsed.data.openAiCompatible === undefined && parsed.data.anthropicCompatible === undefined) {
    throw new Error(`Invalid provider manifest ${manifestPath}: transport defaults are required.`);
  }
  return parsed.data;
}