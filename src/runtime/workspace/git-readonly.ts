import { execFileSync } from "node:child_process";

export function runGitReadOnly(cwd: string, args: string[]): { error: string | null; output: string } {
  try {
    return {
      error: null,
      output: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: message,
      output: ""
    };
  }
}
