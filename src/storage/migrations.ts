import type { DatabaseSync } from "node:sqlite";

export function runMigrations(database: DatabaseSync): void {
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      requester_user_id TEXT NOT NULL DEFAULT 'local-user',
      current_iteration INTEGER NOT NULL,
      max_iterations INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      final_output TEXT,
      error_code TEXT,
      error_message TEXT,
      token_budget_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS traces (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      stage TEXT NOT NULL,
      actor TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_traces_task_id ON traces(task_id, sequence);

    CREATE TABLE IF NOT EXISTS tool_calls (
      tool_call_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT,
      summary TEXT,
      requested_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tool_calls_task_id ON tool_calls(task_id, requested_at);

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tool_call_id TEXT,
      artifact_type TEXT NOT NULL,
      uri TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id, created_at);

    CREATE TABLE IF NOT EXISTS run_metadata (
      run_metadata_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      runtime_version TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL DEFAULT 'executor',
      requester_user_id TEXT NOT NULL DEFAULT 'local-user',
      timeout_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      token_budget_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      reviewer_id TEXT,
      reviewer_notes TEXT,
      policy_decision_id TEXT NOT NULL,
      error_code TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_task_id ON approvals(task_id, requested_at);
    CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(status, expires_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      audit_id TEXT PRIMARY KEY,
      task_id TEXT,
      tool_call_id TEXT,
      approval_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_task_id ON audit_logs(task_id, created_at);

    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      task_id TEXT PRIMARY KEY,
      iteration INTEGER NOT NULL,
      memory_context_json TEXT NOT NULL,
      messages_json TEXT NOT NULL,
      pending_tool_calls_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(database, "tasks", "agent_profile_id", "TEXT NOT NULL DEFAULT 'executor'");
  addColumnIfMissing(database, "tasks", "requester_user_id", "TEXT NOT NULL DEFAULT 'local-user'");
  addColumnIfMissing(
    database,
    "run_metadata",
    "agent_profile_id",
    "TEXT NOT NULL DEFAULT 'executor'"
  );
  addColumnIfMissing(
    database,
    "run_metadata",
    "requester_user_id",
    "TEXT NOT NULL DEFAULT 'local-user'"
  );
}

function addColumnIfMissing(
  database: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string
): void {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  if (rows.some((row) => row.name === columnName)) {
    return;
  }

  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
