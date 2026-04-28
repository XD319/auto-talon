import type { DatabaseSync } from "node:sqlite";

import type {
  ClarifyPromptDraft,
  ClarifyPromptRecord,
  ClarifyPromptRepository,
  ClarifyPromptUpdatePatch
} from "../../types/index.js";

interface ClarifyPromptRow {
  prompt_id: string;
  task_id: string;
  tool_call_id: string;
  requester_user_id: string;
  question: string;
  reason: string | null;
  options_json: string;
  allow_custom_answer: number;
  placeholder: string | null;
  status: ClarifyPromptRecord["status"];
  requested_at: string;
  expires_at: string;
  answered_at: string | null;
  answer_option_id: string | null;
  answer_text: string | null;
  reviewer_id: string | null;
  error_code: ClarifyPromptRecord["errorCode"];
}

export class SqliteClarifyPromptRepository implements ClarifyPromptRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(record: ClarifyPromptDraft): ClarifyPromptRecord {
    this.database
      .prepare(
        `
          INSERT INTO clarify_prompts (
            prompt_id,
            task_id,
            tool_call_id,
            requester_user_id,
            question,
            reason,
            options_json,
            allow_custom_answer,
            placeholder,
            status,
            requested_at,
            expires_at,
            answered_at,
            answer_option_id,
            answer_text,
            reviewer_id,
            error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        record.promptId,
        record.taskId,
        record.toolCallId,
        record.requesterUserId,
        record.question,
        record.reason ?? null,
        JSON.stringify(record.options ?? []),
        record.allowCustomAnswer ? 1 : 0,
        record.placeholder ?? null,
        "pending",
        record.requestedAt,
        record.expiresAt,
        null,
        null,
        null,
        null,
        null
      );

    const created = this.findById(record.promptId);
    if (created === null) {
      throw new Error(`Clarify prompt ${record.promptId} was not persisted.`);
    }
    return created;
  }

  public findById(promptId: string): ClarifyPromptRecord | null {
    const row = this.database
      .prepare("SELECT * FROM clarify_prompts WHERE prompt_id = ?")
      .get(promptId) as ClarifyPromptRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public findLatestByToolCall(taskId: string, toolCallId: string): ClarifyPromptRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM clarify_prompts
          WHERE task_id = ? AND tool_call_id = ?
          ORDER BY requested_at DESC, prompt_id DESC
          LIMIT 1
        `
      )
      .get(taskId, toolCallId) as ClarifyPromptRow | undefined;
    return row === undefined ? null : this.mapRow(row);
  }

  public listByTaskId(taskId: string): ClarifyPromptRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM clarify_prompts WHERE task_id = ? ORDER BY requested_at ASC, prompt_id ASC")
      .all(taskId) as unknown as ClarifyPromptRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public listPending(): ClarifyPromptRecord[] {
    const rows = this.database
      .prepare("SELECT * FROM clarify_prompts WHERE status = 'pending' ORDER BY requested_at ASC")
      .all() as unknown as ClarifyPromptRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public update(promptId: string, patch: ClarifyPromptUpdatePatch): ClarifyPromptRecord {
    const existing = this.findById(promptId);
    if (existing === null) {
      throw new Error(`Clarify prompt ${promptId} was not found.`);
    }

    const nextRecord: ClarifyPromptRecord = {
      ...existing,
      answeredAt: patch.answeredAt === undefined ? existing.answeredAt : patch.answeredAt,
      answerOptionId: patch.answerOptionId === undefined ? existing.answerOptionId : patch.answerOptionId,
      answerText: patch.answerText === undefined ? existing.answerText : patch.answerText,
      reviewerId: patch.reviewerId === undefined ? existing.reviewerId : patch.reviewerId,
      errorCode: patch.errorCode === undefined ? existing.errorCode : patch.errorCode,
      status: patch.status ?? existing.status
    };

    this.database
      .prepare(
        `
          UPDATE clarify_prompts
          SET status = ?,
              answered_at = ?,
              answer_option_id = ?,
              answer_text = ?,
              reviewer_id = ?,
              error_code = ?
          WHERE prompt_id = ?
        `
      )
      .run(
        nextRecord.status,
        nextRecord.answeredAt,
        nextRecord.answerOptionId,
        nextRecord.answerText,
        nextRecord.reviewerId,
        nextRecord.errorCode,
        promptId
      );

    const updated = this.findById(promptId);
    if (updated === null) {
      throw new Error(`Clarify prompt ${promptId} disappeared after update.`);
    }
    return updated;
  }

  private mapRow(row: ClarifyPromptRow): ClarifyPromptRecord {
    return {
      promptId: row.prompt_id,
      taskId: row.task_id,
      toolCallId: row.tool_call_id,
      requesterUserId: row.requester_user_id,
      question: row.question,
      reason: row.reason,
      options: JSON.parse(row.options_json) as ClarifyPromptRecord["options"],
      allowCustomAnswer: row.allow_custom_answer === 1,
      placeholder: row.placeholder,
      status: row.status,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      answeredAt: row.answered_at,
      answerOptionId: row.answer_option_id,
      answerText: row.answer_text,
      reviewerId: row.reviewer_id,
      errorCode: row.error_code
    };
  }
}
