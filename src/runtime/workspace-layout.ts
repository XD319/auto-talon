import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";

export type WorkspaceMode = "initialized" | "user-managed";
export interface WorkspaceLayout { configRoot: string | null; stateRoot: string; userConfigRoot: string; workingDirectory: string; workspaceId: string; workspaceMode: WorkspaceMode; workspaceRoot: string | null; }

export function resolveUserConfigRoot(): string {
  const configured = process.env.AGENT_USER_CONFIG_DIR?.trim();
  return resolve(configured && configured.length > 0 ? configured : join(homedir(), ".auto-talon"));
}

export function normalizeWorkspacePath(input: string): string {
  let canonical = resolve(input);
  try { canonical = realpathSync.native(canonical); } catch { /* lexical fallback */ }
  let value = normalize(canonical).replace(/[\\/]+$/u, "");
  if (process.platform === "win32") value = value.toLowerCase();
  return value;
}

export function workspaceIdForPath(input: string): string {
  return createHash("sha256").update(normalizeWorkspacePath(input), "utf8").digest("hex");
}

export function findInitializedWorkspace(startPath: string): string | null {
  let candidate = resolve(startPath);
  while (true) {
    const configRoot = join(candidate, ".auto-talon");
    if (configRoot !== resolveUserConfigRoot() && existsSync(join(configRoot, "runtime.config.json"))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function resolveWorkspaceLayout(cwd = process.cwd()): WorkspaceLayout {
  const workingDirectory = resolve(cwd);
  const explicit = process.env.AGENT_WORKSPACE_ROOT?.trim();
  const workspaceRoot = explicit && explicit.length > 0 ? resolve(explicit) : findInitializedWorkspace(workingDirectory);
  const workspaceId = workspaceIdForPath(workspaceRoot ?? workingDirectory);
  const userConfigRoot = resolveUserConfigRoot();
  return { configRoot: workspaceRoot === null ? null : join(workspaceRoot, ".auto-talon"), stateRoot: workspaceRoot === null ? join(userConfigRoot, "workspaces", workspaceId) : join(workspaceRoot, ".auto-talon"), userConfigRoot, workingDirectory, workspaceId, workspaceMode: workspaceRoot === null ? "user-managed" : "initialized", workspaceRoot };
}

export function ensureWorkspaceState(layout: WorkspaceLayout): void {
  mkdirSync(layout.stateRoot, { recursive: true });
  for (const name of ["sessions", "rollbacks", "skill-drafts"]) mkdirSync(join(layout.stateRoot, name), { recursive: true });
  const tokenPath = join(layout.stateRoot, "http.token");
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, `${randomBytes(32).toString("hex")}\n`, { encoding: "utf8", mode: 0o600 });
  const metadataPath = join(layout.stateRoot, "workspace.json");
  if (!existsSync(metadataPath)) writeFileSync(metadataPath, `${JSON.stringify({ normalizedPath: normalizeWorkspacePath(layout.workspaceRoot ?? layout.workingDirectory), path: layout.workspaceRoot ?? layout.workingDirectory, workspaceId: layout.workspaceId, workspaceMode: layout.workspaceMode }, null, 2)}\n`, "utf8");
}
