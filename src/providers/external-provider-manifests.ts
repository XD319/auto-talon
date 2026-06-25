import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseExternalProviderManifest } from "./provider-config-schema.js";
import type { ProviderCatalogEntry, ProviderTransportKind } from "./provider-registry.js";

export interface ExternalProviderManifest {
  aliases: string[];
  anthropicVersion: string | null;
  baseUrl: string | null;
  contextWindowTokens: number | null;
  displayName: string;
  model: string | null;
  name: string;
  providerLabel: string | null;
  supportsConfiguration: boolean;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  transport: Exclude<ProviderTransportKind, "mock">;
}

export function loadExternalProviderManifests(input: {
  userConfigDir: string;
  workspaceRoot: string;
}): ExternalProviderManifest[] {
  const user = loadManifestDirectory(join(input.userConfigDir, "providers"));
  const workspace = loadManifestDirectory(join(resolve(input.workspaceRoot), ".auto-talon", "providers"));
  return mergeExternalManifests(user, workspace);
}

export function externalManifestToCatalogEntry(
  manifest: ExternalProviderManifest
): ProviderCatalogEntry {
  return {
    aliases: [...manifest.aliases],
    contextWindowTokens: manifest.contextWindowTokens,
    displayName: manifest.displayName,
    family: manifest.transport,
    name: manifest.name,
    supportsConfiguration: manifest.supportsConfiguration,
    supportsStreaming: manifest.supportsStreaming,
    supportsToolCalls: manifest.supportsToolCalls,
    transport: manifest.transport
  };
}

function loadManifestDirectory(directory: string): ExternalProviderManifest[] {
  if (!existsSync(directory)) {
    return [];
  }

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .flatMap((entry) => {
      const file = join(directory, entry.name);
      const content = readFileSync(file, "utf8").trim();
      if (content.length === 0) {
        return [];
      }
      const parsed: unknown = JSON.parse(content);
      const manifest = parseExternalProviderManifest(parsed, file);
      if (manifest.transport === "mock") {
        throw new Error(`External provider manifest ${file} cannot use mock transport.`);
      }
      return [
        {
          aliases: manifest.aliases ?? [],
          anthropicVersion: manifest.anthropicCompatible?.anthropicVersion ?? null,
          baseUrl:
            manifest.openAiCompatible?.defaultBaseUrl ??
            manifest.anthropicCompatible?.defaultBaseUrl ??
            null,
          contextWindowTokens: manifest.contextWindowTokens ?? null,
          displayName: manifest.displayName,
          model:
            manifest.openAiCompatible?.defaultModel ??
            manifest.anthropicCompatible?.defaultModel ??
            null,
          name: manifest.name,
          providerLabel:
            manifest.openAiCompatible?.providerLabel ??
            manifest.anthropicCompatible?.providerLabel ??
            null,
          supportsConfiguration: manifest.supportsConfiguration ?? true,
          supportsStreaming: manifest.supportsStreaming ?? true,
          supportsToolCalls: manifest.supportsToolCalls ?? true,
          transport: manifest.transport
        }
      ];
    });
}

function mergeExternalManifests(
  user: ExternalProviderManifest[],
  workspace: ExternalProviderManifest[]
): ExternalProviderManifest[] {
  const byName = new Map<string, ExternalProviderManifest>();
  for (const manifest of user) {
    byName.set(manifest.name, manifest);
  }
  for (const manifest of workspace) {
    byName.set(manifest.name, manifest);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
