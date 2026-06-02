import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { AppError } from "../core/app-error.js";

import { buildChildEnv, resolveDefaultShellConfig } from "./shell/shell-executor.js";

export interface TerminalStartRequest {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalSessionSnapshot {
  command: string;
  cwd: string;
  exitCode: number | null;
  running: boolean;
  sessionId: string;
}

interface TerminalSession extends TerminalSessionSnapshot {
  process: ChildProcessWithoutNullStreams;
  stderrBuffer: string;
  stdoutBuffer: string;
  startedAt: string;
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly shellConfig = resolveDefaultShellConfig();
  private readonly maxBufferedChars: number;

  public constructor(options: { maxBufferedChars?: number } = {}) {
    this.maxBufferedChars = options.maxBufferedChars ?? 200_000;
  }

  public start(request: TerminalStartRequest): TerminalSessionSnapshot {
    const sessionId = randomUUID();
    const child = spawn(this.shellConfig.executable, [...this.shellConfig.args, request.command], {
      cwd: request.cwd,
      env: buildChildEnv(process.env, request.env),
      stdio: "pipe",
      windowsHide: true
    });
    const session: TerminalSession = {
      command: request.command,
      cwd: request.cwd,
      exitCode: null,
      process: child,
      running: true,
      sessionId,
      startedAt: new Date().toISOString(),
      stderrBuffer: "",
      stdoutBuffer: ""
    };

    child.stdout.on("data", (chunk: Buffer) => {
      session.stdoutBuffer = appendWithLimit(session.stdoutBuffer, chunk.toString("utf8"), this.maxBufferedChars);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      session.stderrBuffer = appendWithLimit(session.stderrBuffer, chunk.toString("utf8"), this.maxBufferedChars);
    });
    child.once("close", (exitCode) => {
      session.exitCode = exitCode ?? -1;
      session.running = false;
    });
    child.once("error", (error) => {
      session.stderrBuffer = appendWithLimit(session.stderrBuffer, error.message, this.maxBufferedChars);
      session.exitCode = -1;
      session.running = false;
    });

    this.sessions.set(sessionId, session);
    return snapshot(session);
  }

  public read(sessionId: string): TerminalSessionSnapshot & { stderr: string; stdout: string } {
    const session = this.requireSession(sessionId);
    const stdout = session.stdoutBuffer;
    const stderr = session.stderrBuffer;
    session.stdoutBuffer = "";
    session.stderrBuffer = "";
    return {
      ...snapshot(session),
      stderr,
      stdout
    };
  }

  public write(sessionId: string, data: string): TerminalSessionSnapshot {
    const session = this.requireSession(sessionId);
    if (!session.running) {
      throw new AppError({
        code: "tool_execution_error",
        message: `Terminal session ${sessionId} is not running.`
      });
    }
    session.process.stdin.write(data);
    return snapshot(session);
  }

  public stop(sessionId: string): TerminalSessionSnapshot {
    const session = this.requireSession(sessionId);
    if (session.running) {
      session.process.kill();
      session.running = false;
    }
    return snapshot(session);
  }

  private requireSession(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new AppError({
        code: "tool_validation_error",
        message: `Terminal session ${sessionId} was not found.`
      });
    }
    return session;
  }
}

function snapshot(session: TerminalSession): TerminalSessionSnapshot {
  return {
    command: session.command,
    cwd: session.cwd,
    exitCode: session.exitCode,
    running: session.running,
    sessionId: session.sessionId
  };
}

function appendWithLimit(current: string, next: string, maxLength: number): string {
  const combined = current + next;
  return combined.length <= maxLength ? combined : combined.slice(combined.length - maxLength);
}
