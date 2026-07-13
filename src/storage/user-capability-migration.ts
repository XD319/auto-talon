import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "../runtime/workspace-layout.js";

export interface UserCapabilityMigrationResult { applied: boolean; environmentVariables: string[]; sourceFiles: string[]; targetFiles: string[]; warnings: string[]; }

export function migrateUserCapabilities(cwd: string, apply = false): UserCapabilityMigrationResult {
  const layout = resolveWorkspaceLayout(cwd);
  const warnings: string[] = [];
  const environmentVariables = new Set<string>();
  if (layout.configRoot === null) return { applied: false, environmentVariables: [], sourceFiles: [], targetFiles: [], warnings: ["No initialized workspace configuration was found."] };
  const writes: Array<{ path: string; value: Record<string, unknown> }> = [];
  const sourceFiles: string[] = [];
  const providerPath = join(layout.configRoot, "provider.config.json");
  if (existsSync(providerPath)) { sourceFiles.push(providerPath); writes.push({ path: join(layout.userConfigRoot, "provider.config.json"), value: removePlainSecrets(readObject(providerPath), [], environmentVariables, warnings) as Record<string, unknown> }); }
  const runtimePath = join(layout.configRoot, "runtime.config.json");
  if (existsSync(runtimePath)) {
    const runtime = readObject(runtimePath); const capabilities: Record<string, unknown> = { version: runtime.version ?? 1 };
    if (runtime.web !== undefined) capabilities.web = removePlainSecrets(runtime.web, ["web"], environmentVariables, warnings);
    if (runtime.webSearch !== undefined) capabilities.webSearch = removePlainSecrets(runtime.webSearch, ["webSearch"], environmentVariables, warnings);
    if (Object.keys(capabilities).length > 1) { sourceFiles.push(runtimePath); writes.push({ path: join(layout.userConfigRoot, "runtime.config.json"), value: capabilities }); }
  }
  if (apply) { mkdirSync(layout.userConfigRoot, { recursive: true }); for (const write of writes) { const existing = existsSync(write.path) ? readObject(write.path) : {}; writeFileSync(write.path, `${JSON.stringify(deepMerge(existing, write.value), null, 2)}\n`, "utf8"); } }
  return { applied: apply, environmentVariables: [...environmentVariables].sort(), sourceFiles, targetFiles: writes.map((write) => write.path), warnings };
}

function readObject(path: string): Record<string, unknown> { const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown; if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Expected JSON object in ${path}.`); return parsed as Record<string, unknown>; }
function removePlainSecrets(value: unknown, path: string[], env: Set<string>, warnings: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry, index) => removePlainSecrets(entry, [...path, String(index)], env, warnings));
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/^(apiKey|api_key|token|secret|password)$/iu.test(key) && typeof child === "string" && child.length > 0) { const envName = `AUTO_TALON_${[...path, key].join("_").replace(/[^a-z0-9]+/giu, "_").toUpperCase()}`; result[`${key}Env`] = envName; env.add(envName); warnings.push(`Plain credential ${[...path, key].join(".")} was not copied; set ${envName}.`); }
    else result[key] = removePlainSecrets(child, [...path, key], env, warnings);
  }
  return result;
}
function deepMerge(base: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> { const result = { ...base }; for (const [key, value] of Object.entries(next)) { const current = result[key]; result[key] = current !== null && typeof current === "object" && !Array.isArray(current) && value !== null && typeof value === "object" && !Array.isArray(value) ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>) : value; } return result; }
