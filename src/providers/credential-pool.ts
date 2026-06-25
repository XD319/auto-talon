import type { JsonObject } from "../types/index.js";

export type ProviderCredentialStatus = "available" | "cooldown" | "disabled" | "missing";
export type ProviderCredentialSource = "env" | "legacy_api_key" | "plaintext";

export interface ProviderCredentialFileEntry extends JsonObject {
  apiKey?: string | null;
  apiKeyEnv?: string | null;
  cooldownUntil?: string | null;
  disabled?: boolean;
  id?: string;
  lastFailure?: string | null;
  priority?: number;
}

export interface ResolvedProviderCredential {
  apiKey: string | null;
  apiKeyEnv: string | null;
  cooldownUntil: string | null;
  disabled: boolean;
  id: string;
  lastFailure: string | null;
  priority: number;
  source: ProviderCredentialSource;
  status: ProviderCredentialStatus;
}

export interface ProviderCredentialSummary extends JsonObject {
  activeCredentialId: string | null;
  availableCredentialIds: string[];
  credentialCount: number;
  credentialStatus: ProviderCredentialStatus;
  credentialSource: ProviderCredentialSource | null;
}

export function resolveProviderCredentials(input: {
  credentials?: ProviderCredentialFileEntry[] | undefined;
  envApiKey?: string | undefined;
  ignoreProviderEnv: boolean;
  legacyApiKey?: string | null | undefined;
  requestedCredentialId?: string | undefined;
}): ResolvedProviderCredential[] {
  if (!input.ignoreProviderEnv && isNonEmpty(input.envApiKey)) {
    return [
      {
        apiKey: input.envApiKey.trim(),
        apiKeyEnv: "AGENT_PROVIDER_API_KEY",
        cooldownUntil: null,
        disabled: false,
        id: "env:AGENT_PROVIDER_API_KEY",
        lastFailure: null,
        priority: -1,
        source: "env",
        status: "available"
      }
    ];
  }

  const explicit = normalizeCredentialEntries(input.credentials ?? []);
  const legacy = normalizeNullableString(input.legacyApiKey);
  const entries =
    explicit.length > 0
      ? explicit
      : legacy === null
        ? []
        : [
            {
              apiKey: legacy,
              apiKeyEnv: null,
              cooldownUntil: null,
              disabled: false,
              id: "default",
              lastFailure: null,
              priority: 0,
              source: "legacy_api_key" as const
            }
          ];

  const resolved = entries
    .map((entry) => resolveCredential(entry))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));

  if (input.requestedCredentialId === undefined) {
    return resolved;
  }

  const requested = resolved.find((credential) => credential.id === input.requestedCredentialId);
  return requested === undefined ? resolved : [requested, ...resolved.filter((credential) => credential !== requested)];
}

export function summarizeProviderCredentials(
  credentials: ResolvedProviderCredential[]
): ProviderCredentialSummary {
  const active = credentials.find((credential) => credential.status === "available") ?? null;
  const status =
    active?.status ??
    credentials.find((credential) => credential.status === "cooldown")?.status ??
    credentials.find((credential) => credential.status === "disabled")?.status ??
    "missing";
  return {
    activeCredentialId: active?.id ?? null,
    availableCredentialIds: credentials
      .filter((credential) => credential.status === "available")
      .map((credential) => credential.id),
    credentialCount: credentials.length,
    credentialSource: active?.source ?? null,
    credentialStatus: status
  };
}

export function selectActiveCredential(credentials: ResolvedProviderCredential[]): ResolvedProviderCredential | null {
  return credentials.find((credential) => credential.status === "available") ?? null;
}

function normalizeCredentialEntries(
  entries: ProviderCredentialFileEntry[]
): Array<Omit<ResolvedProviderCredential, "apiKey" | "status"> & { apiKey: string | null }> {
  return entries
    .map((entry, index) => {
      const id = normalizeNullableString(entry.id) ?? `credential-${index + 1}`;
      const apiKeyEnv = normalizeNullableString(entry.apiKeyEnv);
      const apiKey = normalizeNullableString(entry.apiKey);
      return {
        apiKey,
        apiKeyEnv,
        cooldownUntil: normalizeNullableString(entry.cooldownUntil),
        disabled: entry.disabled === true,
        id,
        lastFailure: normalizeNullableString(entry.lastFailure),
        priority: normalizePriority(entry.priority, index),
        source: apiKeyEnv === null ? "plaintext" as const : "env" as const
      };
    });
}

function resolveCredential(
  entry: Omit<ResolvedProviderCredential, "apiKey" | "status"> & { apiKey: string | null }
): ResolvedProviderCredential {
  const apiKey = entry.apiKeyEnv === null ? entry.apiKey : normalizeNullableString(process.env[entry.apiKeyEnv]);
  const status = resolveCredentialStatus({
    apiKey,
    cooldownUntil: entry.cooldownUntil,
    disabled: entry.disabled
  });
  return {
    ...entry,
    apiKey,
    status
  };
}

function resolveCredentialStatus(input: {
  apiKey: string | null;
  cooldownUntil: string | null;
  disabled: boolean;
}): ProviderCredentialStatus {
  if (input.disabled) {
    return "disabled";
  }
  if (input.cooldownUntil !== null) {
    const cooldownUntil = Date.parse(input.cooldownUntil);
    if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
      return "cooldown";
    }
  }
  if (input.apiKey === null || input.apiKey.length === 0) {
    return "missing";
  }
  return "available";
}

function normalizeNullableString(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizePriority(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
