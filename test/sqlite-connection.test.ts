import { mkdtempSync, rmSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { StorageManager } from "../src/storage/database.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "../src/storage/sqlite-connection.js";

const tempPaths: string[] = [];
const cliBin = join(process.cwd(), "src", "cli", "bin.ts");
const tsxLoader = pathToFileURL(join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs")).href;

afterEach(() => {
  while (tempPaths.length > 0) {
    const tempPath = tempPaths.pop();
    if (tempPath !== undefined) {
      rmSync(tempPath, { force: true, recursive: true });
    }
  }
});

describe("sqlite connection configuration", () => {
  it("sets busy_timeout on each StorageManager connection", () => {
    const workspace = createTempDir("auto-talon-sqlite-timeout-");
    const databasePath = join(workspace, ".auto-talon", "agent-runtime.db");
    const first = new StorageManager({ databasePath });
    first.close();

    const second = new StorageManager({ databasePath });
    try {
      const row = second.database.prepare("PRAGMA busy_timeout").get() as { timeout?: number };
      expect(row.timeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
    } finally {
      second.close();
    }
  });

  it("waits for a concurrent database writer instead of failing read-only CLI startup", async () => {
    const workspace = createTempDir("auto-talon-sqlite-lock-");
    const userConfigDir = createTempDir("auto-talon-sqlite-lock-user-");
    const databasePath = join(workspace, ".auto-talon", "agent-runtime.db");
    const storage = new StorageManager({ databasePath });
    storage.close();

    const locker = spawnSqliteWriteLock(databasePath);
    try {
      await waitForLockerReady(locker);
      const result = runCli(workspace, ["skills", "list"], {
        AGENT_PROVIDER: "mock",
        AGENT_USER_CONFIG_DIR: userConfigDir
      });

      expect(`${result.stdout}\n${result.stderr}`).not.toContain("database is locked");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No enabled skills found.");
    } finally {
      await stopLocker(locker);
    }
  }, 20_000);
});

function createTempDir(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(workspace);
  return workspace;
}

function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined>
): { status: number | null; stderr: string; stdout: string } {
  const result = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", tsxLoader, cliBin, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env
      },
      timeout: 15_000
    }
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

function spawnSqliteWriteLock(databasePath: string): ChildProcessWithoutNullStreams {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER); INSERT INTO lock_probe (id) VALUES (1);");
    process.stdout.write("locked\\n");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
    }, 1_000);
  `;
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "-e", script, databasePath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

function waitForLockerReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for SQLite lock. stdout=${stdout} stderr=${stderr}`)));
    }, 5_000);

    const finish = (handler: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      handler();
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("locked")) {
        finish(resolve);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      if (!stdout.includes("locked")) {
        finish(() => reject(new Error(`SQLite lock process exited before locking: ${code}. stderr=${stderr}`)));
      }
    });
    child.once("error", (error) => {
      finish(() => reject(error));
    });
  });
}

async function stopLocker(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const exit = waitForExit(child);
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
  });
  await Promise.race([exit, timeout]);
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
  });
}
