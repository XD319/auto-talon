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

export function parseNonNegativeIntegerOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new InvalidArgumentError(`${optionName} must be a non-negative integer.`);
    }
    return parsed;
  };
}

export function parseNonNegativeNumberOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new InvalidArgumentError(`${optionName} must be a non-negative number.`);
    }
    return parsed;
  };
}

export function parseRatioOption(optionName: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      throw new InvalidArgumentError(`${optionName} must be a number between 0 and 1.`);
    }
    return parsed;
  };
}

/** One-shot automation must not wait on provider keep-alive sockets after the result is printed. */
export function finishCliProcess(): void {
  if (process.env.TALON_FORCE_EXIT !== "1") {
    return;
  }
  const code = process.exitCode ?? 0;
  let pending = 0;
  const finish = (): void => {
    if (pending === 0) {
      process.exit(code);
    }
  };
  for (const stream of [process.stdout, process.stderr]) {
    if (stream.writableLength === 0) {
      continue;
    }
    pending += 1;
    stream.once("drain", () => {
      pending -= 1;
      finish();
    });
  }
  finish();
}

export function parseApprovalAllowScope(value: string | undefined): "once" | "session" | "always" {
  if (value === undefined || value === "once") {
    return "once";
  }
  if (value === "session" || value === "always") {
    return value;
  }
  throw new InvalidArgumentError("Scope must be once, session, or always.");
}
