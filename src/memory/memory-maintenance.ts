import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import { scanMemoryContent } from "./memory-safety.js";

export interface MemoryMaintenanceReport {
  mode: "dry-run" | "apply";
  affectedMemories: number;
  affectedExperiences: number;
  duplicateGroups: number;
  archivedMemories: number;
  archivedExperiences: number;
  generatedSuggestions: number;
  databaseBytes: number;
  backupPath: string | null;
}

export class MemoryMaintenanceService {
  public constructor(private readonly database: DatabaseSync, private readonly databasePath: string) {}

  public rebuild(mode: "dry-run" | "apply"): MemoryMaintenanceReport {
    const candidateMemories = this.count("SELECT COUNT(*) AS count FROM memories WHERE status = 'candidate' AND scope IN ('profile','project')");
    const candidateExperiences = this.count("SELECT COUNT(*) AS count FROM experiences WHERE status = 'candidate'");
    const duplicateGroups = this.count(`SELECT COUNT(*) AS count FROM (
      SELECT scope_name, scope_key, type, lower(trim(content)) fingerprint
      FROM experiences WHERE status = 'candidate'
      GROUP BY scope_name, scope_key, type, fingerprint HAVING COUNT(*) > 1
    )`);
    const promotable = this.promotableGroups();
    const report: MemoryMaintenanceReport = {
      mode,
      affectedMemories: candidateMemories,
      affectedExperiences: candidateExperiences,
      duplicateGroups,
      archivedMemories: mode === "apply" ? candidateMemories : 0,
      archivedExperiences: mode === "apply" ? candidateExperiences : 0,
      generatedSuggestions: mode === "apply" ? promotable.length : promotable.length,
      databaseBytes: this.databasePath === ":memory:" ? 0 : statSync(this.databasePath).size,
      backupPath: null
    };
    if (mode === "dry-run") return report;
    if (this.databasePath === ":memory:") throw new Error("Maintenance apply requires a file-backed database.");
    const backupPath = `${this.databasePath}.${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
    this.database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    report.backupPath = backupPath;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE status = 'candidate' AND scope IN ('profile','project')").run(new Date().toISOString());
      this.database.prepare("UPDATE experiences SET status = 'archived', updated_at = ? WHERE status = 'candidate'").run(new Date().toISOString());
      for (const group of promotable) this.createSuggestion(group);
      this.database.prepare("DELETE FROM session_core_snapshots").run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return report;
  }

  public doctor(): Record<string, unknown> {
    const profileCore = this.count("SELECT COUNT(*) AS count FROM memories WHERE tier='core' AND scope='profile' AND status='verified'");
    const projectCore = this.count("SELECT COUNT(*) AS count FROM memories WHERE tier='core' AND scope='project' AND status='verified'");
    return {
      core: { profile: profileCore, project: projectCore },
      pendingSuggestions: this.count("SELECT COUNT(*) AS count FROM inbox_items WHERE category='memory_suggestion' AND status='pending'"),
      statuses: {
        archived: this.count("SELECT COUNT(*) AS count FROM memories WHERE status='archived'"),
        candidate: this.count("SELECT COUNT(*) AS count FROM memories WHERE status='candidate'"),
        verified: this.count("SELECT COUNT(*) AS count FROM memories WHERE status='verified'")
      },
      missingSource: this.count("SELECT COUNT(*) AS count FROM memories WHERE source_json IS NULL OR source_json='{}'"),
      conflictGroups: this.count("SELECT COUNT(*) AS count FROM memories WHERE conflicts_with_json <> '[]'"),
      embeddingCoverage: this.embeddingCoverage()
    };
  }

  private promotableGroups(): Array<{ scopeKey: string; scopeName: string; type: string; content: string; count: number }> {
    const rows = this.database.prepare(`SELECT scope_name, scope_key, type, content, COUNT(*) count,
      MIN(confidence) min_confidence, MIN(value_score) min_value
      FROM experiences WHERE status='candidate'
      GROUP BY scope_name, scope_key, type, lower(trim(content))
      HAVING COUNT(*) >= 3 AND MIN(confidence) >= 0.70 AND MIN(value_score) >= 0.70`).all() as Array<{
        scope_name: string; scope_key: string; type: string; content: string; count: number;
      }>;
    return rows.filter((row) => scanMemoryContent(row.content).allowed).map((row) => ({ scopeKey: row.scope_key, scopeName: row.scope_name, type: row.type, content: row.content, count: row.count }));
  }

  private createSuggestion(group: { scopeKey: string; scopeName: string; type: string; content: string; count: number }): void {
    const dedupKey = `memory_maintenance:${group.scopeName}:${group.scopeKey}:${group.type}:${group.content.toLowerCase().trim()}`;
    const exists = this.database.prepare("SELECT inbox_id FROM inbox_items WHERE dedup_key = ?").get(dedupKey);
    if (exists !== undefined) return;
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO inbox_items (
      inbox_id,user_id,task_id,session_id,schedule_run_id,approval_id,experience_id,skill_id,
      category,severity,status,title,summary,body_md,action_hint,source_trace_id,dedup_key,
      created_at,updated_at,done_at,metadata_json
    ) VALUES (?, ?, NULL,NULL,NULL,NULL,NULL,NULL,'memory_suggestion','action_required','pending',?,?,?,?,NULL,?,?,?,NULL,?)`).run(
      randomUUID(), "local-user", `Promote repeated ${group.type} evidence`,
      `${group.count} consistent archived experiences passed maintenance thresholds.`, group.content,
      "Review before promotion", dedupKey, now, now,
      JSON.stringify({ action: "add", source: "maintenance", scopeKey: group.scopeKey, target: group.scopeName === "profile" ? "profile" : "project", evidenceCount: group.count })
    );
  }

  private count(sql: string): number { return (this.database.prepare(sql).get() as { count?: number } | undefined)?.count ?? 0; }
  private embeddingCoverage(): number {
    const eligible = this.count("SELECT COUNT(*) AS count FROM memories WHERE status='verified' AND privacy_level IN ('public','internal')");
    const embedded = this.count("SELECT COUNT(*) AS count FROM memory_embeddings");
    return eligible === 0 ? 1 : Number((embedded / eligible).toFixed(4));
  }
}