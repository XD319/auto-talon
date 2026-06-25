import type { DatabaseSync } from "node:sqlite";

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export function configureSqliteConnection(database: DatabaseSync): void {
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
}
