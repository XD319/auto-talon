import type { ModelSelectionView } from "../runtime/operations/model-selection-service.js";

export function formatConfiguredModelSection(view: Pick<ModelSelectionView, "configuredModels">): string[] {
  const lines = ["Configured models:"];
  if (view.configuredModels.length === 0) {
    lines.push("- (none)");
    return lines;
  }
  for (const [index, entry] of view.configuredModels.entries()) {
    const marker = entry.current ? " *" : "";
    lines.push(`- ${index + 1}. ${entry.selection} (${entry.displayName}) [${entry.configSource}]${marker}`);
  }
  return lines;
}

export function formatEnvironmentOnlyModelSection(view: Pick<ModelSelectionView, "envOnlyProviders">): string[] {
  if (view.envOnlyProviders.length === 0) {
    return [];
  }
  return [
    "",
    "Environment-only (not persistable):",
    ...view.envOnlyProviders.map((entry) => `- ${entry.selection} [env]`)
  ];
}

export function formatModelAliasSection(view: Pick<ModelSelectionView, "aliases">): string[] {
  if (view.aliases.length === 0) {
    return [];
  }
  return [
    "",
    "Aliases:",
    ...view.aliases.map((entry) => `- ${entry.alias} -> ${entry.target}${entry.current ? " *" : ""}`)
  ];
}

export function formatFallbackProviderSection(fallback: ModelSelectionView["fallback"]): string[] {
  const lines = ["", "Fallback providers:"];
  if (fallback.main.length === 0) {
    lines.push("- (none)");
    return lines;
  }
  for (const [index, selection] of fallback.main.entries()) {
    lines.push(`- ${index + 1}. ${selection}`);
  }
  return lines;
}

export function formatAuxiliaryFallbackSection(fallback: ModelSelectionView["fallback"]): string[] {
  if (Object.keys(fallback.auxiliary).length === 0) {
    return [];
  }
  return [
    "",
    "Auxiliary fallback:",
    ...Object.entries(fallback.auxiliary).map(([slot, selections]) => `- ${slot}: ${selections.join(" -> ")}`)
  ];
}

export function formatFallbackStatusSection(fallback: ModelSelectionView["fallback"]): string[] {
  if (fallback.status.updatedAt === null) {
    return [];
  }
  const lines = ["", "Fallback status:", `- updatedAt: ${fallback.status.updatedAt}`];
  if (fallback.status.activeFallback !== null) {
    lines.push(
      `- active: ${fallback.status.activeFallback.fromProvider} -> ${fallback.status.activeFallback.providerName} (${fallback.status.activeFallback.reason})`
    );
  }
  if (fallback.status.lastFailure !== null) {
    lines.push(
      `- last failure: ${fallback.status.lastFailure.providerName} ${fallback.status.lastFailure.errorCategory}`
    );
  }
  return lines;
}

export function formatAuxiliarySlotSection(
  auxiliary: Record<string, string>,
  options: { emptyLabel?: string } = {}
): string[] {
  const lines = ["", "Auxiliary slots:"];
  const entries = Object.entries(auxiliary);
  if (entries.length === 0) {
    if (options.emptyLabel !== undefined) {
      lines.push(options.emptyLabel);
    }
    return lines;
  }
  for (const [slot, selection] of entries) {
    lines.push(`- ${slot}: ${selection}`);
  }
  return lines;
}
