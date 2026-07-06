import { InvalidArgumentError } from "commander";

import {
  createApplication,
  type AppRuntimeHandle,
  type CreateApplicationOptions,
  type ResolveAppConfigOptions
} from "../runtime/index.js";

export interface SandboxCommandOptions {
  cwd: string;
  sandboxMode?: string;
  sandboxProfile?: string;
  writeRoot?: string[];
}

export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function withApplication<T>(
  cwd: string,
  action: (handle: AppRuntimeHandle) => T,
  options: CreateApplicationOptions = {}
): T {
  const handle = createApplication(cwd, options);
  try {
    return action(handle);
  } finally {
    handle.close();
  }
}

export function parsePositiveIntegerOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(`${optionName} must be a positive integer.`);
    }
    return parsed;
  };
}

export function parsePortOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = parsePositiveIntegerOption(optionName)(value);
    if (parsed > 65535) {
      throw new InvalidArgumentError(`${optionName} must be between 1 and 65535.`);
    }
    return parsed;
  };
}

export function parseNullableOption(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "null" || normalized === "-" ? null : value;
}

export function resolveSandboxCliOptions(options: SandboxCommandOptions): ResolveAppConfigOptions {
  return {
    ...(options.sandboxMode === "local" || options.sandboxMode === "docker"
      ? { sandboxMode: options.sandboxMode }
      : {}),
    ...(options.sandboxProfile !== undefined ? { sandboxProfile: options.sandboxProfile } : {}),
    ...(options.writeRoot !== undefined ? { writeRoots: options.writeRoot } : {})
  };
}
