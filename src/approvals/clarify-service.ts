import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../runtime/app-error.js";
import type {
  ClarifyPromptOption,
  ClarifyPromptRecord,
  ClarifyPromptRepository,
  RuntimeErrorCode
} from "../types/index.js";

export interface ClarifyServiceConfig {
  clarifyTtlMs: number;
  now?: () => Date;
}

const clarifyAnswerSchema = z
  .object({
    promptId: z.string().min(1),
    reviewerId: z.string().min(1),
    answerOptionId: z.string().min(1).optional(),
    answerText: z.string().min(1).optional()
  })
  .refine((value) => value.answerOptionId !== undefined || value.answerText !== undefined, {
    message: "answerOptionId or answerText is required."
  });

const clarifyCancelSchema = z.object({
  promptId: z.string().min(1),
  reviewerId: z.string().min(1)
});

export interface EnsureClarifyPromptInput {
  taskId: string;
  toolCallId: string;
  requesterUserId: string;
  question: string;
  reason?: string | null;
  options?: ClarifyPromptOption[];
  allowCustomAnswer: boolean;
  placeholder?: string | null;
}

export interface ClarifyAnswerInput {
  promptId: string;
  reviewerId: string;
  answerOptionId?: string;
  answerText?: string;
}

export interface ClarifyCancelInput {
  promptId: string;
  reviewerId: string;
}

export class ClarifyService {
  private readonly now: () => Date;

  public constructor(
    private readonly clarifyPromptRepository: ClarifyPromptRepository,
    private readonly config: ClarifyServiceConfig
  ) {
    this.now = config.now ?? (() => new Date());
  }

  public ensurePrompt(input: EnsureClarifyPromptInput): { created: boolean; prompt: ClarifyPromptRecord } {
    const existing = this.clarifyPromptRepository.findLatestByToolCall(input.taskId, input.toolCallId);
    if (existing !== null) {
      return {
        created: false,
        prompt: this.expireIfNeeded(existing)
      };
    }

    const now = this.now();
    return {
      created: true,
      prompt: this.clarifyPromptRepository.create({
        promptId: randomUUID(),
        taskId: input.taskId,
        toolCallId: input.toolCallId,
        requesterUserId: input.requesterUserId,
        question: input.question,
        reason: input.reason ?? null,
        options: input.options ?? [],
        allowCustomAnswer: input.allowCustomAnswer,
        placeholder: input.placeholder ?? null,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.config.clarifyTtlMs).toISOString()
      })
    };
  }

  public findById(promptId: string): ClarifyPromptRecord | null {
    const prompt = this.clarifyPromptRepository.findById(promptId);
    return prompt === null ? null : this.expireIfNeeded(prompt);
  }

  public listPending(): ClarifyPromptRecord[] {
    return this.clarifyPromptRepository
      .listPending()
      .map((prompt) => this.expireIfNeeded(prompt))
      .filter((prompt) => prompt.status === "pending");
  }

  public listByTaskId(taskId: string): ClarifyPromptRecord[] {
    return this.clarifyPromptRepository.listByTaskId(taskId).map((prompt) => this.expireIfNeeded(prompt));
  }

  public answer(input: ClarifyAnswerInput): ClarifyPromptRecord {
    const parsed = clarifyAnswerSchema.parse(input);
    const prompt = this.findById(parsed.promptId);
    if (prompt === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Clarify prompt ${parsed.promptId} was not found.`
      });
    }
    if (prompt.status !== "pending") {
      return prompt;
    }

    return this.clarifyPromptRepository.update(parsed.promptId, {
      status: "answered",
      answeredAt: this.now().toISOString(),
      answerOptionId: parsed.answerOptionId ?? null,
      answerText: parsed.answerText ?? null,
      reviewerId: parsed.reviewerId,
      errorCode: null
    });
  }

  public cancel(input: ClarifyCancelInput): ClarifyPromptRecord {
    const parsed = clarifyCancelSchema.parse(input);
    const prompt = this.findById(parsed.promptId);
    if (prompt === null) {
      throw new AppError({
        code: "task_not_found",
        message: `Clarify prompt ${parsed.promptId} was not found.`
      });
    }
    if (prompt.status !== "pending") {
      return prompt;
    }

    return this.clarifyPromptRepository.update(parsed.promptId, {
      status: "cancelled",
      answeredAt: this.now().toISOString(),
      reviewerId: parsed.reviewerId,
      errorCode: "clarification_cancelled"
    });
  }

  public expirePending(): ClarifyPromptRecord[] {
    const expired: ClarifyPromptRecord[] = [];
    for (const prompt of this.clarifyPromptRepository.listPending()) {
      const normalized = this.expireIfNeeded(prompt);
      if (normalized.status === "timed_out") {
        expired.push(normalized);
      }
    }
    return expired;
  }

  public toErrorCode(status: ClarifyPromptRecord["status"]): RuntimeErrorCode {
    switch (status) {
      case "answered":
      case "pending":
        return "approval_required";
      case "cancelled":
        return "clarification_cancelled";
      case "timed_out":
        return "approval_timeout";
      default:
        return "approval_required";
    }
  }

  private expireIfNeeded(prompt: ClarifyPromptRecord): ClarifyPromptRecord {
    if (prompt.status !== "pending") {
      return prompt;
    }
    if (Date.parse(prompt.expiresAt) > this.now().getTime()) {
      return prompt;
    }
    return this.clarifyPromptRepository.update(prompt.promptId, {
      status: "timed_out",
      answeredAt: this.now().toISOString(),
      reviewerId: "system",
      errorCode: "approval_timeout"
    });
  }
}
