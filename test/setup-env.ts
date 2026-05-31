import { join } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach } from "vitest";

const originalEmitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  if (isSqliteExperimentalWarning(warning, args)) {
    return;
  }

  originalEmitWarning(warning, ...args);
}) as typeof process.emitWarning;

beforeEach(() => {
  process.env.AGENT_PROVIDER ??= "mock";
  process.env.AGENT_USER_CONFIG_DIR ??= join(tmpdir(), "auto-talon-vitest-user-config");
});

function isSqliteExperimentalWarning(warning: string | Error, args: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning.message;
  const name = typeof warning === "string" ? args.find((arg): arg is string => typeof arg === "string") : warning.name;
  return name === "ExperimentalWarning" && message.includes("SQLite");
}
