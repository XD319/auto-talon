import { z } from "zod";

const providerFileEntrySchema = z
  .object({
    apiKey: z.string().nullable().optional(),
    baseUrl: z.string().nullable().optional(),
    contextWindowTokens: z.number().int().positive().nullable().optional(),
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
    modelAliases: z.record(z.string(), z.string()).optional(),
    providers: z.record(z.string(), providerFileEntrySchema).optional()
  })
  .passthrough();

export type ProviderConfigFileSchema = z.infer<typeof providerConfigFileSchema>;

export function parseProviderConfigFile(content: unknown, configPath: string): ProviderConfigFileSchema {
  const parsed = providerConfigFileSchema.safeParse(content);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`Invalid provider config ${configPath}: ${details}`);
  }
  return parsed.data;
}
