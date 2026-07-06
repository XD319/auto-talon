import { z } from "zod";

import type { ClarifyService } from "../../approvals/clarify-service.js";
import type { ClarifyPromptRecord, ExecutionCheckpointRecord, TaskRecord } from "../../types/index.js";
import type { TraceService } from "../../tracing/trace-service.js";
import type { ExecutionKernel } from "../execution-kernel.js";
import type { ScheduleRunLifecycle } from "../scheduler/index.js";
import { AppError, toAppError } from "../app-error.js";
import type { ClarifyActionResult } from "../application-service.js";

const clarifyAnswerSchema = z
  .object({
    answerOptionId: z.string().min(1).optional(),
    answerText: z.string().min(1).optional(),
    answers: z.record(z.string().min(1), z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).optional(),
    response: z.string().min(1).optional(),
    promptId: z.string().min(1),
    reviewerId: z.string().min(1)
  })
  .refine(
    (value) =>
      value.answerOptionId !== undefined ||
      value.answerText !== undefined ||
      value.answers !== undefined ||
      value.response !== undefined,
    {
      message: "answerOptionId, answerText, answers, or response is required."
    }
  );

export interface ClarifyResolutionFacadeDependencies {
  clarifyService: ClarifyService;
  executionKernel: ExecutionKernel;
  findExecutionCheckpoint: (taskId: string) => ExecutionCheckpointRecord | null;
  findTask: (taskId: string) => TaskRecord | null;
  saveExecutionCheckpoint: (record: ExecutionCheckpointRecord) => ExecutionCheckpointRecord;
  scheduleRunLifecycle: ScheduleRunLifecycle;
  traceService: TraceService;
}

export interface ClarifyResolutionCallbacks {
  projectAssistantOutput: (sessionId: string | null, taskId: string, output: string | null) => void;
  releaseSessionLockIfTerminal: (task: TaskRecord) => void;
}

export class ClarifyResolutionFacade {
  public constructor(
    private readonly dependencies: ClarifyResolutionFacadeDependencies,
    private readonly callbacks: ClarifyResolutionCallbacks
  ) {}

  public async answerClarifyPrompt(
    promptId: string,
    reviewerId: string,
    input: {
      answerOptionId?: string;
      answerText?: string;
      answers?: Record<string, string | string[]>;
      response?: string;
    }
  ): Promise<ClarifyActionResult> {
    const parsed = clarifyAnswerSchema.parse({
      ...input,
      promptId,
      reviewerId
    });
    const prompt = this.dependencies.clarifyService.answer({
      promptId: parsed.promptId,
      reviewerId: parsed.reviewerId,
      ...(parsed.answerOptionId !== undefined ? { answerOptionId: parsed.answerOptionId } : {}),
      ...(parsed.answerText !== undefined ? { answerText: parsed.answerText } : {}),
      ...(parsed.answers !== undefined ? { answers: parsed.answers } : {}),
      ...(parsed.response !== undefined ? { response: parsed.response } : {})
    });
    const checkpoint = this.dependencies.findExecutionCheckpoint(prompt.taskId);
    if (checkpoint === null) {
      throw new AppError({
        code: "task_not_resumable",
        message: `Task ${prompt.taskId} has no checkpoint for clarification.`
      });
    }

    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "clarify_resolved",
      payload: {
        answerOptionId: prompt.answerOptionId,
        answers: prompt.answers,
        answerText: prompt.answerText,
        promptId: prompt.promptId,
        response: prompt.response,
        status: "answered"
      },
      stage: "governance",
      summary: `Clarification answered for task ${prompt.taskId}`,
      taskId: prompt.taskId
    });

    const answerText = formatClarifyAnswerForModel(prompt);
    const updatedCheckpoint = {
      ...checkpoint,
      messages: [
        ...checkpoint.messages,
        {
          role: "user" as const,
          content: answerText,
          metadata: {
            clarifyPromptId: prompt.promptId,
            clarifyAnswerOptionId: prompt.answerOptionId
          }
        }
      ],
      pendingClarifyPromptId: null,
      updatedAt: new Date().toISOString()
    };
    this.dependencies.saveExecutionCheckpoint(updatedCheckpoint);

    try {
      const taskBeforeResume = this.dependencies.findTask(prompt.taskId);
      if (taskBeforeResume !== null) {
        this.dependencies.scheduleRunLifecycle.markResuming(taskBeforeResume);
      }
      const result = await this.dependencies.executionKernel.resumeTask(prompt.taskId);
      this.dependencies.scheduleRunLifecycle.syncRunFromTask(result.task);
      this.callbacks.releaseSessionLockIfTerminal(result.task);
      this.callbacks.projectAssistantOutput(
        result.task.sessionId ?? null,
        result.task.taskId,
        result.output ?? null
      );
      return {
        output: result.output,
        prompt,
        task: result.task
      };
    } catch (error) {
      const appError = toAppError(error);
      const task = this.dependencies.findTask(prompt.taskId);
      if (task === null) {
        throw appError;
      }
      return {
        error: appError,
        output: null,
        prompt,
        task
      };
    }
  }

  public cancelClarifyPrompt(promptId: string, reviewerId: string): ClarifyActionResult {
    const prompt = this.dependencies.clarifyService.cancel({ promptId, reviewerId });
    this.dependencies.traceService.record({
      actor: `reviewer.${reviewerId}`,
      eventType: "clarify_cancelled",
      payload: {
        promptId: prompt.promptId,
        reviewerId
      },
      stage: "governance",
      summary: `Clarification cancelled for task ${prompt.taskId}`,
      taskId: prompt.taskId
    });

    const failedTask = this.dependencies.executionKernel.failWaitingClarificationTask(
      prompt.taskId,
      new AppError({
        code: "clarification_cancelled",
        message: `Clarification prompt ${prompt.promptId} was cancelled.`
      })
    );

    return {
      output: null,
      prompt,
      task: failedTask
    };
  }
}

function formatClarifyAnswerForModel(prompt: ClarifyPromptRecord): string {
  if (prompt.response !== null) {
    return prompt.response;
  }
  const answers = prompt.answers ?? deriveLegacyClarifyAnswers(prompt);
  if (answers !== null) {
    return Object.entries(answers)
      .map(([question, answer]) => {
        const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
        return `${question}\nAnswer: ${answerText}`;
      })
      .join("\n\n");
  }
  return (
    prompt.answerText ??
    prompt.options.find((item) => item.id === prompt.answerOptionId)?.label ??
    ""
  );
}

function deriveLegacyClarifyAnswers(prompt: ClarifyPromptRecord): Record<string, string | string[]> | null {
  if (prompt.answerText !== null) {
    return { [prompt.question]: prompt.answerText };
  }
  if (prompt.answerOptionId !== null) {
    const option = prompt.options.find((item) => item.id === prompt.answerOptionId);
    if (option !== undefined) {
      return { [prompt.question]: option.label };
    }
  }
  return null;
}
