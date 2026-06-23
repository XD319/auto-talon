export type ModelAliasMap = Record<string, string>;

const MAX_ALIAS_DEPTH = 8;

export function normalizeModelAliases(
  aliases: Record<string, string> | undefined
): ModelAliasMap {
  if (aliases === undefined) {
    return {};
  }

  const normalized: ModelAliasMap = {};
  for (const [key, value] of Object.entries(aliases)) {
    const alias = key.trim();
    const target = value.trim();
    if (alias.length === 0 || target.length === 0) {
      continue;
    }
    normalized[alias.toLowerCase()] = target;
  }
  return normalized;
}

export function mergeModelAliases(
  userAliases: Record<string, string> | undefined,
  workspaceAliases: Record<string, string> | undefined
): ModelAliasMap {
  return {
    ...normalizeModelAliases(userAliases),
    ...normalizeModelAliases(workspaceAliases)
  };
}

export function resolveModelAlias(
  selection: string,
  aliases: ModelAliasMap
): string {
  const trimmed = selection.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const visited = new Set<string>();
  let current = trimmed;
  let depth = 0;

  while (depth < MAX_ALIAS_DEPTH) {
    const key = current.toLowerCase();
    if (visited.has(key)) {
      throw new Error(`Model alias cycle detected for "${selection}".`);
    }
    visited.add(key);

    const next = aliases[key];
    if (next === undefined) {
      return current;
    }
    current = next;
    depth += 1;
  }

  throw new Error(`Model alias chain too deep for "${selection}".`);
}

export function listModelAliasEntries(aliases: ModelAliasMap): Array<{ alias: string; target: string }> {
  return Object.entries(aliases).map(([alias, target]) => ({
    alias,
    target
  }));
}
