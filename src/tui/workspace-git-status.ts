import { runGitReadOnly } from "../runtime/workspace/git-readonly.js";

export interface GitBranchStatus {
  branch: string;
  dirty: boolean;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { at: number; value: GitBranchStatus | null }>();

export function clearGitBranchStatusCache(): void {
  cache.clear();
}

export function readGitBranchStatus(cwd: string, now = Date.now()): GitBranchStatus | null {
  const cached = cache.get(cwd);
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const value = readGitBranchStatusUncached(cwd);
  cache.set(cwd, { at: now, value });
  return value;
}

function readGitBranchStatusUncached(cwd: string): GitBranchStatus | null {
  const branchResult = runGitReadOnly(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branchResult.error !== null) {
    return null;
  }

  const branch = branchResult.output.trim();
  if (branch.length === 0) {
    return null;
  }

  const statusResult = runGitReadOnly(cwd, ["status", "--porcelain"]);
  if (statusResult.error !== null) {
    return { branch, dirty: false };
  }

  return {
    branch,
    dirty: statusResult.output.trim().length > 0
  };
}

export function formatGitBranchLabel(status: GitBranchStatus): string {
  return status.dirty ? `${status.branch}*` : status.branch;
}
