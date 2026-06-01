import { randomUUID } from "node:crypto";
import { z } from "zod";

import { buildApprovalFingerprint } from "../approvals/approval-fingerprint.js";
import type { ApprovalRuleStore } from "../approvals/approval-rule-store.js";
import type { ClarifyService } from "../approvals/clarify-service.js";
import { AppError, toAppError } from "../core/app-error.js";
import { safePreview } from "../core/serialization.js";
import type { ApprovalService } from "../approvals/approval-service.js";
import type { AuditService } from "../audit/audit-service.js";
import type { ContextPolicy } from "../policy/context-policy.js";
import type { PolicyEngine } from "../policy/policy-engine.js";
import type { TraceService } from "../tracing/trace-service.js";
import type {
  ApprovalRecord,
  ClarifyPromptRecord,
  ArtifactRepository,
  JsonObject,
  ProviderToolDescriptor,
  SandboxExecutionPlan,
  ToolCallRecord,
  ToolCallRepository,
  ToolCallRequest,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutionSuccess
} from "../types/index.js";
import type { PreparedAskUserInput } from "./ask-user-tool.js";

export interface ToolOrchestratorDependencies {
  approvalService: ApprovalService;
  approvalRuleStore: ApprovalRuleStore;
  artifactRepository: ArtifactRepository;
  auditService: AuditService;
  clarifyService: ClarifyService;
  contextPolicy: ContextPolicy;
  policyEngine: PolicyEngine;
  toolCallRepository: ToolCallRepository;
  traceService: TraceService;
  tools: ToolDefinition[];
}

export interface ToolExecutionCompletedOutcome {
  kind: "completed";
  result: ToolExecutionResult;
  toolCall: ToolCallRecord;
}

export interface ToolExecutionApprovalRequiredOutcome {
  approval: ApprovalRecord;
  kind: "approval_required";
  toolCall: ToolCallRecord;
}

export interface ToolExecutionClarifyRequiredOutcome {
  kind: "clarify_required";
  prompt: ClarifyPromptRecord;
  toolCall: ToolCallRecord;
}

export type ToolExecutionOutcome =
  | ToolExecutionCompletedOutcome
  | ToolExecutionApprovalRequiredOutcome
  | ToolExecutionClarifyRequiredOutcome;

export class ToolOrchestrator {
  private readonly tools = new Map<string, ToolDefinition>();

  public constructor(private readonly dependencies: ToolOrchestratorDependencies) {
    for (const tool of dependencies.tools) {
      this.tools.set(tool.name, tool);
    }
  }

  public listTools(allowedToolNames?: string[]): ProviderToolDescriptor[] {
    return [...this.tools.values()]
      .filter((tool) => allowedToolNames === undefined || allowedToolNames.includes(tool.name))
      .map((tool) => ({
        capability: tool.capability,
        description: tool.description,
        inputSchema: tool.inputSchemaDescriptor,
        name: tool.name,
        privacyLevel: tool.privacyLevel,
        riskLevel: tool.riskLevel
      }));
  }

  public listToolsWithMetadata(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  public describeTool(toolName: string): ProviderToolDescriptor | null {
    const tool = this.resolveTool(toolName);
    if (tool === undefined) {
      return null;
    }

    return {
      capability: tool.capability,
      description: tool.description,
      inputSchema: tool.inputSchemaDescriptor,
      name: tool.name,
      privacyLevel: tool.privacyLevel,
      riskLevel: tool.riskLevel
    };
  }

  private resolveTool(toolName: string): ToolDefinition | undefined {
    return this.tools.get(toolName) ?? this.tools.get(resolveToolAlias(toolName));
  }

  public async execute(
    request: ToolCallRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutcome> {
    const tool = this.resolveTool(request.toolName);
    const riskLevel = tool?.riskLevel ?? "high";
    let toolCall = this.ensureToolCallRecord(
      request,
      riskLevel,
      tool !== undefined && !isMutationTool(tool)
    );

    if (tool === undefined) {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "tool_not_found",
          message: `Tool ${request.toolName} is not registered.`
        })
      );
    }

    const replayOutcome = this.replayTerminalOutcome(toolCall);
    if (replayOutcome !== null) {
      const replayedSummary =
        toolCall.summary ?? `Tool ${tool.name} finished (replayed).`;
      this.dependencies.traceService.record({
        actor: `tool.${tool.name}`,
        eventType: "tool_call_finished",
        payload: {
          iteration: request.iteration,
          outputPreview: safePreview(toolCall.output),
          replayed: true,
          status: toolCall.status,
          summary: replayedSummary,
          toolCallId: toolCall.toolCallId,
          toolName: tool.name
        },
        stage: "tooling",
        summary: `Tool ${tool.name} replayed from persisted terminal status`,
        taskId: request.taskId
      });
      return replayOutcome;
    }

    if (tool.checkAvailability !== undefined) {
      const availability = await tool.checkAvailability(context);
      if (!availability.available) {
        return this.failToolCall(
          toolCall,
          new AppError({
            code: "tool_unavailable",
            details: {
              reason: availability.reason
            },
            message: `Tool ${tool.name} is unavailable: ${availability.reason}`
          })
        );
      }
    }

    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) {
      const validationSummary = summarizeValidationIssues(parsed.error.issues);
      const validationError = new AppError({
        code: "tool_validation_error",
        details: {
          issues: z.treeifyError(parsed.error)
        },
        message: validationSummary
      });
      if (isRecoverableToolFailure(tool)) {
        return this.completeToolCallFailure(toolCall, validationError);
      }
      return this.failToolCall(toolCall, validationError);
    }

    let prepared: Awaited<ReturnType<typeof tool.prepare>>;
    try {
      prepared = await tool.prepare(parsed.data, context);
      this.recordSandboxEvent(request, tool.name, prepared.sandbox, "allowed");
    } catch (error) {
      const appError = toAppError(error);
      this.recordSandboxFailure(request, tool.name, appError);
      return this.failToolCall(toolCall, appError);
    }

    const policyDecision = this.dependencies.policyEngine.evaluate({
      agentProfileId: context.agentProfileId,
      capability: tool.capability,
      metadata: {
        sandboxKind: prepared.sandbox.kind,
        summary: prepared.governance.summary
      },
      pathScope: prepared.governance.pathScope,
      privacyLevel: tool.privacyLevel,
      riskLevel: tool.riskLevel,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId,
      toolName: tool.name,
      userId: context.userId,
      workspaceRoot: context.workspaceRoot
    });

    this.dependencies.traceService.record({
      actor: "policy.engine",
      eventType: "policy_decision",
      payload: {
        capability: tool.capability,
        decisionId: policyDecision.decisionId,
        effect: policyDecision.effect,
        matchedRuleId: policyDecision.matchedRuleId,
        pathScope: prepared.governance.pathScope,
        privacyLevel: tool.privacyLevel,
        riskLevel: tool.riskLevel,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name
      },
      stage: "governance",
      summary: policyDecision.reason,
      taskId: request.taskId
    });

    this.dependencies.auditService.record({
      action: "policy_decision",
      actor: "policy.engine",
      approvalId: null,
      outcome:
        policyDecision.effect === "deny"
          ? "denied"
          : policyDecision.effect === "allow_with_approval"
            ? "pending"
            : "approved",
      payload: {
        capability: tool.capability,
        decisionId: policyDecision.decisionId,
        effect: policyDecision.effect,
        matchedRuleId: policyDecision.matchedRuleId,
        pathScope: prepared.governance.pathScope,
        privacyLevel: tool.privacyLevel,
        riskLevel: tool.riskLevel,
        toolName: tool.name
      },
      summary: policyDecision.reason,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId
    });

    if (policyDecision.effect === "deny") {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "policy_denied",
          details: {
            decisionId: policyDecision.decisionId
          },
          message: policyDecision.reason
        })
      );
    }

    if (policyDecision.effect === "allow_with_approval") {
      const fingerprint = buildApprovalFingerprint(tool.name, prepared.sandbox);
      const sessionApprovalFingerprints = readSessionApprovalFingerprints(context.taskMetadata);
      const autoApproved =
        sessionApprovalFingerprints.includes(fingerprint.fingerprint) ||
        this.dependencies.approvalRuleStore.hasFingerprint(fingerprint.fingerprint);

      if (!autoApproved) {
        const approvalRequest = this.dependencies.approvalService.ensureApprovalRequest({
          fingerprint: fingerprint.fingerprint,
          policyDecisionId: policyDecision.decisionId,
          reason: formatApprovalReason(request.reason, prepared.sandbox),
          requesterUserId: context.userId,
          taskId: request.taskId,
          toolCallId: toolCall.toolCallId,
          toolName: tool.name
        });

        const approval = approvalRequest.approval;
        if (approval.status === "pending") {
          toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
            status: toolCall.status === "approved" ? "approved" : "awaiting_approval"
          });

          if (approvalRequest.created) {
            this.dependencies.traceService.record({
              actor: "approval.service",
              eventType: "approval_requested",
              payload: {
                approvalId: approval.approvalId,
                expiresAt: approval.expiresAt,
                toolCallId: toolCall.toolCallId,
                toolName: tool.name
              },
              stage: "governance",
              summary: `Approval requested for ${tool.name}`,
              taskId: request.taskId
            });

            this.dependencies.auditService.record({
              action: "approval_requested",
              actor: "approval.service",
              approvalId: approval.approvalId,
              outcome: "pending",
              payload: {
                expiresAt: approval.expiresAt,
                fingerprint: approval.fingerprint,
                reason: approval.reason,
                toolName: approval.toolName
              },
              summary: `Approval requested for ${tool.name}`,
              taskId: request.taskId,
              toolCallId: toolCall.toolCallId
            });
          }

          return {
            approval,
            kind: "approval_required",
            toolCall
          };
        }

        if (approval.status === "denied") {
          return this.failToolCall(
            toolCall,
            new AppError({
              code: "approval_denied",
              details: {
                approvalId: approval.approvalId
              },
              message: `Approval ${approval.approvalId} was denied for ${tool.name}.`
            }),
            "denied"
          );
        }

        if (approval.status === "timed_out") {
          return this.failToolCall(
            toolCall,
            new AppError({
              code: "approval_timeout",
              details: {
                approvalId: approval.approvalId
              },
              message: `Approval ${approval.approvalId} timed out for ${tool.name}.`
            }),
            "timed_out"
          );
        }
      }

      if (toolCall.status === "requested") {
        toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
          status: "awaiting_approval"
        });
      }
      toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
        status: "approved"
      });
    }

    if (tool.capability === "interaction.ask_user") {
      if (toolCall.status === "requested") {
        toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
          startedAt: new Date().toISOString(),
          status: "started"
        });
      }

      return this.resolveClarifyPrompt(
        toolCall,
        request,
        context,
        prepared.preparedInput as PreparedAskUserInput
      );
    }

    toolCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
      startedAt: new Date().toISOString(),
      status: "started"
    });

    this.dependencies.traceService.record({
      actor: `tool.${tool.name}`,
      eventType: "tool_call_started",
      payload: {
        iteration: request.iteration,
        toolCallId: toolCall.toolCallId,
        toolName: tool.name
      },
      stage: "tooling",
      summary: `Tool ${tool.name} started`,
      taskId: request.taskId
    });

    try {
      const result = await tool.execute(prepared.preparedInput, context);
      if (!result.success) {
        const toolError =
          result.details === undefined
            ? new AppError({
                code: result.errorCode,
                message: result.errorMessage
              })
            : new AppError({
                code: result.errorCode,
                details: result.details,
                message: result.errorMessage
              });
        if (isRecoverableToolFailure(tool)) {
          return this.completeToolCallFailure(toolCall, toolError);
        }
        return this.failToolCall(toolCall, toolError);
      }

      this.dependencies.artifactRepository.createMany(
        request.taskId,
        toolCall.toolCallId,
        result.artifacts ?? []
      );

      const persistedOutput = sanitizePersistedOutput(
        result.output,
        tool.privacyLevel,
        this.dependencies.contextPolicy
      );
      const finishedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
        finishedAt: new Date().toISOString(),
        output: persistedOutput,
        status: "finished",
        summary: result.summary
      });

      this.dependencies.traceService.record({
        actor: `tool.${tool.name}`,
        eventType: "tool_call_finished",
        payload: {
          iteration: request.iteration,
          outputPreview: safePreview(persistedOutput),
          summary: result.summary,
          toolCallId: finishedCall.toolCallId,
          toolName: tool.name
        },
        stage: "tooling",
        summary: `Tool ${tool.name} finished`,
        taskId: request.taskId
      });

      this.recordToolAudit(tool, request, finishedCall, "succeeded", result);

      return {
        kind: "completed",
        result,
        toolCall: finishedCall
      };
    } catch (error) {
      const appError = toToolExecutionError(error);
      if (isRecoverableToolFailure(tool)) {
        return this.completeToolCallFailure(toolCall, appError);
      }
      return this.failToolCall(toolCall, appError);
    }
  }

  private ensureToolCallRecord(
    request: ToolCallRequest,
    riskLevel: ToolCallRecord["riskLevel"],
    allowCrossTaskReplay: boolean
  ): ToolCallRecord {
    const existing = this.dependencies.toolCallRepository.findById(request.toolCallId);
    if (existing !== null && existing.taskId === request.taskId) {
      return existing;
    }
    if (
      existing !== null &&
      allowCrossTaskReplay &&
      existing.toolName === request.toolName &&
      JSON.stringify(existing.input) === JSON.stringify(request.input)
    ) {
      return existing;
    }

    const toolCallId = existing === null ? request.toolCallId || randomUUID() : randomUUID();
    const toolCall = this.dependencies.toolCallRepository.create({
      errorCode: null,
      errorMessage: null,
      finishedAt: null,
      input: request.input,
      iteration: request.iteration,
      output: null,
      requestedAt: new Date().toISOString(),
      riskLevel,
      startedAt: null,
      status: "requested",
      summary: null,
      taskId: request.taskId,
      toolCallId,
      toolName: request.toolName
    });

    this.dependencies.traceService.record({
      actor: "runtime.orchestrator",
      eventType: "tool_call_requested",
      payload: {
        input: request.input,
        iteration: request.iteration,
        originalToolCallId: existing === null ? null : request.toolCallId,
        reason: request.reason,
        riskLevel,
        toolCallId: toolCall.toolCallId,
        toolName: request.toolName
      },
      stage: "tooling",
      summary: `Tool ${request.toolName} requested`,
      taskId: request.taskId
    });

    if (riskLevel === "high") {
      this.dependencies.auditService.record({
        action: "high_risk_tool_requested",
        actor: "runtime.orchestrator",
        approvalId: null,
        outcome: "attempted",
        payload: {
          input: request.input,
          reason: request.reason,
          riskLevel,
          toolName: request.toolName
        },
        summary: `High-risk tool ${request.toolName} requested`,
        taskId: request.taskId,
        toolCallId: toolCall.toolCallId
      });
    }

    return toolCall;
  }

  private recordSandboxEvent(
    request: ToolCallRequest,
    toolName: string,
    sandboxPlan: SandboxExecutionPlan,
    status: "allowed" | "denied"
  ): void {
    const target = getSandboxTarget(sandboxPlan);
    this.dependencies.traceService.record({
      actor: "sandbox.service",
      eventType: "sandbox_enforced",
      payload: {
        sandboxKind: sandboxPlan.kind,
        status,
        target,
        toolCallId: request.toolCallId,
        toolName
      },
      stage: "governance",
      summary: `Sandbox ${status} for ${toolName}`,
      taskId: request.taskId
    });

    this.dependencies.auditService.record({
      action: "sandbox_enforced",
      actor: "sandbox.service",
      approvalId: null,
      outcome: status === "allowed" ? "approved" : "denied",
      payload: {
        sandbox: sandboxPlan,
        target,
        toolName
      },
      summary: `Sandbox ${status} for ${toolName}`,
      taskId: request.taskId,
      toolCallId: request.toolCallId
    });
  }

  private recordSandboxFailure(
    request: ToolCallRequest,
    toolName: string,
    error: AppError
  ): void {
    const sandboxDetails =
      typeof error.details?.sandbox === "object" && error.details?.sandbox !== null
        ? (error.details.sandbox as Record<string, unknown>)
        : null;

    if (sandboxDetails === null) {
      return;
    }

    const sandboxKind = extractSandboxKind(sandboxDetails);
    const target = extractSandboxTarget(sandboxDetails);
    this.dependencies.traceService.record({
      actor: "sandbox.service",
      eventType: "sandbox_enforced",
      payload: {
        sandboxKind,
        status: "denied",
        target,
        toolCallId: request.toolCallId,
        toolName
      },
      stage: "governance",
      summary: error.message,
      taskId: request.taskId
    });

    this.dependencies.auditService.record({
      action: "sandbox_enforced",
      actor: "sandbox.service",
      approvalId: null,
      outcome: "denied",
      payload: {
        sandbox: sandboxDetails as JsonObject,
        toolName
      },
      summary: error.message,
      taskId: request.taskId,
      toolCallId: request.toolCallId
    });
  }

  private recordToolAudit(
    tool: ToolDefinition,
    request: ToolCallRequest,
    toolCall: ToolCallRecord,
    outcome: "succeeded" | "failed",
    result: ToolExecutionSuccess
  ): void {
    const action =
      tool.capability === "filesystem.write"
        ? "file_write"
        : tool.capability === "shell.execute"
          ? "shell_execution"
          : tool.capability === "network.fetch_public_readonly"
            ? "web_fetch"
            : null;

    if (action === null) {
      return;
    }

    this.dependencies.auditService.record({
      action,
      actor: `tool.${tool.name}`,
      approvalId: null,
      outcome,
      payload: {
        outputPreview: safePreview(result.output),
        summary: result.summary
      },
      summary: result.summary,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId
    });
  }

  private failToolCall(
    toolCall: ToolCallRecord,
    error: AppError,
    status: ToolCallRecord["status"] = "failed"
  ): never {
    this.recordFailedToolCall(toolCall, error, status);
    throw error;
  }

  private completeToolCallFailure(
    toolCall: ToolCallRecord,
    error: AppError,
    status: ToolCallRecord["status"] = "failed"
  ): ToolExecutionCompletedOutcome {
    const failedCall = this.recordFailedToolCall(toolCall, error, status);
    return {
      kind: "completed",
      result: {
        ...(error.details === undefined
          ? {}
          : { details: error.details as JsonObject }),
        errorCode: error.code,
        errorMessage: error.message,
        success: false
      },
      toolCall: failedCall
    };
  }

  private recordFailedToolCall(
    toolCall: ToolCallRecord,
    error: AppError,
    status: ToolCallRecord["status"]
  ): ToolCallRecord {
    const failedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
      errorCode: error.code,
      errorMessage: error.message,
      finishedAt: new Date().toISOString(),
      status
    });

    this.dependencies.traceService.record({
      actor: `tool.${failedCall.toolName}`,
      eventType: "tool_call_failed",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        iteration: failedCall.iteration,
        toolCallId: failedCall.toolCallId,
        toolName: failedCall.toolName
      },
      stage: "tooling",
      summary: `Tool ${failedCall.toolName} failed`,
      taskId: failedCall.taskId
    });

    this.dependencies.auditService.record({
      action: status === "denied" || status === "timed_out" ? "tool_rejected" : "tool_failure",
      actor: `tool.${failedCall.toolName}`,
      approvalId: null,
      outcome:
        status === "denied"
          ? "denied"
          : status === "timed_out"
            ? "timed_out"
            : "failed",
      payload: {
        errorCode: error.code,
        errorMessage: error.message,
        status
      },
      summary: error.message,
      taskId: failedCall.taskId,
      toolCallId: failedCall.toolCallId
    });

    return failedCall;
  }

  private resolveClarifyPrompt(
    toolCall: ToolCallRecord,
    request: ToolCallRequest,
    context: ToolExecutionContext,
    preparedInput: PreparedAskUserInput
  ): ToolExecutionOutcome {
    const promptRequest = this.dependencies.clarifyService.ensurePrompt({
      allowCustomAnswer: preparedInput.allowCustomAnswer,
      options: preparedInput.options,
      placeholder: preparedInput.placeholder,
      question: preparedInput.question,
      questions: preparedInput.questions,
      reason: preparedInput.reason,
      requesterUserId: context.userId,
      taskId: request.taskId,
      toolCallId: toolCall.toolCallId
    });

    const prompt = promptRequest.prompt;
    if (prompt.status === "pending") {
      if (promptRequest.created) {
        this.dependencies.traceService.record({
          actor: "clarify.service",
          eventType: "clarify_requested",
          payload: {
            promptId: prompt.promptId,
            question: prompt.question,
            toolCallId: toolCall.toolCallId
          },
          stage: "governance",
          summary: `Clarification requested: ${prompt.question}`,
          taskId: request.taskId
        });
      }

      return {
        kind: "clarify_required",
        prompt,
        toolCall
      };
    }

    if (prompt.status === "cancelled") {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "clarification_cancelled",
          details: {
            promptId: prompt.promptId
          },
          message: `Clarification prompt ${prompt.promptId} was cancelled.`
        })
      );
    }

    if (prompt.status === "timed_out") {
      return this.failToolCall(
        toolCall,
        new AppError({
          code: "approval_timeout",
          details: {
            promptId: prompt.promptId
          },
          message: `Clarification prompt ${prompt.promptId} timed out.`
        }),
        "timed_out"
      );
    }

    const output: JsonObject = {
      answerOptionId: prompt.answerOptionId,
      answers: prompt.answers ?? deriveLegacyClarifyAnswers(prompt),
      answerText: prompt.answerText,
      promptId: prompt.promptId,
      questions: prompt.questions.map((question) => ({
        allowCustomAnswer: question.allowCustomAnswer,
        ...(question.header !== undefined ? { header: question.header } : {}),
        multiSelect: question.multiSelect,
        options: question.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.description !== undefined ? { description: option.description } : {}),
          ...(option.preview !== undefined ? { preview: option.preview } : {})
        })),
        placeholder: question.placeholder,
        question: question.question
      })),
      response: prompt.response ?? formatClarifyResponse(prompt)
    };
    const summary = `User answered clarify prompt "${prompt.question}"`;
    const finishedCall = this.dependencies.toolCallRepository.update(toolCall.toolCallId, {
      finishedAt: new Date().toISOString(),
      output,
      status: "finished",
      summary
    });

    return {
      kind: "completed",
      result: {
        output,
        success: true,
        summary
      },
      toolCall: finishedCall
    };
  }

  private replayTerminalOutcome(toolCall: ToolCallRecord): ToolExecutionCompletedOutcome | null {
    if (toolCall.status === "failed") {
      throw new AppError({
        code: toolCall.errorCode ?? "tool_execution_error",
        message:
          toolCall.errorMessage ??
          `Tool ${toolCall.toolName} previously failed (replayed).`
      });
    }

    if (toolCall.status !== "finished") {
      return null;
    }

    return {
      kind: "completed",
      result: {
        output: toolCall.output,
        replayed: true,
        success: true,
        summary: toolCall.summary ?? `Tool ${toolCall.toolName} finished (replayed).`
      },
      toolCall
    };
  }
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

function formatClarifyResponse(prompt: ClarifyPromptRecord): string | null {
  const answers = prompt.answers ?? deriveLegacyClarifyAnswers(prompt);
  if (answers === null) {
    return null;
  }
  return Object.entries(answers)
    .map(([question, answer]) => {
      const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
      return `${question}\nAnswer: ${answerText}`;
    })
    .join("\n\n");
}

function isMutationTool(tool: ToolDefinition): boolean {
  return (
    tool.capability === "interaction.ask_user" ||
    tool.capability === "filesystem.write" ||
    tool.sideEffectLevel === "workspace_mutation" ||
    tool.sideEffectLevel === "external_mutation"
  );
}

function summarizeValidationIssues(issues: z.ZodIssue[]): string {
  if (issues.length === 0) {
    return "Tool input validation failed.";
  }

  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join(" | ");
}

function formatApprovalReason(reason: string, sandboxPlan: SandboxExecutionPlan): string {
  if (sandboxPlan.kind !== "file") {
    return reason;
  }

  return [
    reason,
    `Resolved path: ${sandboxPlan.resolvedPath}`,
    `Operation: ${sandboxPlan.operation}`,
    `Path scope: ${sandboxPlan.pathScope}`,
    `Extra write root: ${sandboxPlan.withinExtraWriteRoot === true ? "yes" : "no"}`
  ].join("\n");
}

function getSandboxTarget(sandboxPlan: SandboxExecutionPlan): string {
  switch (sandboxPlan.kind) {
    case "file":
      return sandboxPlan.resolvedPath;
    case "network":
      return sandboxPlan.url;
    case "shell":
      return sandboxPlan.cwd;
    case "mcp":
      return sandboxPlan.target;
    case "prompt":
      return sandboxPlan.target;
    default:
      return "unknown";
  }
}

function extractSandboxKind(sandboxDetails: Record<string, unknown>): "file" | "network" | "shell" | "mcp" | "prompt" {
  const kind = sandboxDetails.kind;
  return kind === "file" || kind === "network" || kind === "shell" || kind === "mcp" || kind === "prompt"
    ? kind
    : "shell";
}

function isRecoverableToolFailure(tool: ToolDefinition): boolean {
  return (
    tool.capability === "filesystem.read" ||
    tool.capability === "filesystem.write" ||
    tool.capability === "shell.execute"
  );
}

function toToolExecutionError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (error instanceof Error) {
    return new AppError({
      cause: error,
      code: "tool_execution_error",
      message: error.message
    });
  }
  return new AppError({
    cause: error,
    code: "tool_execution_error",
    message: "Unknown tool execution error"
  });
}

function extractSandboxTarget(sandboxDetails: Record<string, unknown>): string {
  if (typeof sandboxDetails.resolvedPath === "string") {
    return sandboxDetails.resolvedPath;
  }

  if (typeof sandboxDetails.url === "string") {
    return sandboxDetails.url;
  }

  if (typeof sandboxDetails.cwd === "string") {
    return sandboxDetails.cwd;
  }

  if (typeof sandboxDetails.target === "string") {
    return sandboxDetails.target;
  }

  return "unknown";
}

function readSessionApprovalFingerprints(metadata: ToolExecutionContext["taskMetadata"]): string[] {
  const fingerprints = metadata?.["sessionApprovalFingerprints"];
  if (!Array.isArray(fingerprints)) {
    return [];
  }
  return fingerprints.filter((value): value is string => typeof value === "string");
}

function resolveToolAlias(toolName: string): string {
  if (toolName === "ask_user") {
    return "AskUserQuestion";
  }
  if (toolName === "bash" || toolName === "Bash") {
    return "shell";
  }
  if (toolName === "run_tests" || toolName === "test" || toolName === "tests") {
    return "test_run";
  }
  return toolName;
}

function sanitizePersistedOutput(
  value: ToolExecutionSuccess["output"],
  privacyLevel: ToolDefinition["privacyLevel"],
  contextPolicy: ContextPolicy
): ToolExecutionSuccess["output"] {
  if (privacyLevel !== "restricted") {
    return value;
  }

  if (typeof value === "string") {
    return contextPolicy.redactText(value, privacyLevel);
  }

  return {
    redacted: contextPolicy.redactText(JSON.stringify(value), privacyLevel)
  };
}
